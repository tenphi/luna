/** Immutable email evidence selected for a scheduled report, kept off the delivery channel. */
import type Database from 'better-sqlite3';

import { getSessionState, setSessionState, type WriteOutbound } from '../db/session-db.js';
import { getCachedMessage } from '../host-mcp/builtins/email/shared/cache/messages.js';
import { loadMailConfig } from '../host-mcp/builtins/email/shared/config.js';
import { decodeMailId, encodeMailId } from '../host-mcp/builtins/email/shared/ids.js';
import { log } from '../log.js';
import { createHash } from 'node:crypto';
import { isLearnEnabled, looksLikeSecret } from './digest.js';

export interface ScheduledEmailEvidence {
  thread_id?: string;
  item_id: string;
  text: string;
  role: 'external';
  speaker: string;
  mentioned_at: string;
}

export interface ScheduledEvidence {
  emails: ScheduledEmailEvidence[];
  omitted: number;
  findings?: Array<{ text: string; item_ids: string[] }>;
}

interface ScheduledReads {
  scope?: string;
  ids: string[];
  evidence: ScheduledEvidence;
  selection?: ScheduledEvidence;
}

const MAX_EMAILS = 64;
const READ_PREFIX = 'memory:scheduled-email-reads:';
const MAX_EMAIL_CHARS = 95_000;
// Durable capture is separate from the much smaller individual model request budget.
const MAX_TOTAL_CHARS = 2_000_000;

function mailScope(): string {
  const config = loadMailConfig();
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.enabled,
        config.mailboxes.map((m) => [m.key, m.address, m.ignoreLabels ?? [], m.ignoreSenders ?? []]),
      ]),
    )
    .digest('hex');
}

/**
 * Resolve only explicitly selected, previously fetched emails. Never fetch mail, trust model-
 * supplied headers, or clip a body: a qualifier after the cutoff can reverse the claimed fact.
 */
function snapshotEmailEvidence(ids: unknown): ScheduledEvidence {
  const result: ScheduledEvidence = { emails: [], omitted: 0 };
  if (!Array.isArray(ids)) return result;
  const unique = [...new Set(ids)];
  result.omitted = Math.max(0, unique.length - MAX_EMAILS);
  const config = loadMailConfig();
  const mailboxes = config.enabled ? config.mailboxes.map((mailbox) => mailbox.key) : [];
  let chars = 0;
  const seen = new Set<string>();
  for (const id of unique.slice(0, MAX_EMAILS)) {
    try {
      if (typeof id !== 'string') throw new Error('invalid source id');
      const decoded = decodeMailId(id, mailboxes);
      const mailId = encodeMailId(decoded.mailbox, decoded.gmailId);
      if (seen.has(mailId)) continue;
      seen.add(mailId);
      const message = getCachedMessage(decoded.mailbox, decoded.gmailId);
      if (!message || !message.bodyClean.trim() || message.removed.truncatedChars > 0) {
        throw new Error('complete cached body unavailable');
      }
      // The source clock must include its offset, not an inferred date or the digest's clock.
      if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(message.internalAt)) throw new Error('source clock unavailable');
      const mentionedAt = new Date(message.internalAt).toISOString();
      const speaker = message.from.trim();
      if (!speaker || speaker.length > 200) throw new Error('source speaker unavailable');
      const text = [
        `Email source: ${mailId}`,
        `From: ${speaker}`,
        `To: ${message.to.join(', ')}`,
        ...(message.cc.length ? [`Cc: ${message.cc.join(', ')}`] : []),
        `Subject: ${message.subject}`,
        `Sent at: ${mentionedAt}`,
        `Direction: ${message.outgoing ? 'outgoing' : 'incoming'}`,
        '',
        message.bodyClean,
      ].join('\n');
      if (looksLikeSecret(text) || text.length > MAX_EMAIL_CHARS || chars + text.length > MAX_TOTAL_CHARS) {
        throw new Error('source exceeds safe evidence budget');
      }
      result.emails.push({
        item_id: `email:${mailId}`,
        thread_id: encodeMailId(decoded.mailbox, message.gmThrId),
        text,
        role: 'external',
        speaker,
        mentioned_at: mentionedAt,
      });
      chars += text.length;
    } catch {
      result.omitted += 1;
    }
  }
  return result;
}

/** Capture only reads made while exactly one scheduled run is processing in this session. */
export function recordScheduledEmailReads(db: Database.Database, ids: string[]): void {
  if (!isLearnEnabled(db)) return;
  const runs = db.prepare("SELECT id FROM messages_in WHERE kind = 'task' AND status = 'processing'").all() as {
    id: string;
  }[];
  if (runs.length !== 1) return;
  const key = `${READ_PREFIX}${runs[0]!.id}`;
  let prior = JSON.parse(
    getSessionState(db, key) ?? '{"ids":[],"evidence":{"emails":[],"omitted":0}}',
  ) as ScheduledReads;
  const scope = mailScope();
  if (prior.scope !== scope) prior = { ids: [], evidence: { emails: [], omitted: 0 } };
  const readIds = [...new Set([...prior.ids, ...ids])].slice(0, 128);
  const emails = new Map(prior.evidence.emails.map((email) => [email.item_id, email]));
  // Keep the first complete bytes. A later continuation may fill an earlier omitted body,
  // but cache eviction or a subsequent read cannot replace already captured evidence.
  for (const email of snapshotEmailEvidence(readIds).emails) {
    if (!emails.has(email.item_id)) emails.set(email.item_id, email);
  }
  let chars = 0;
  const bounded = [...emails.values()]
    .filter((email) => {
      if (chars + email.text.length > MAX_TOTAL_CHARS) return false;
      chars += email.text.length;
      return true;
    })
    .slice(0, MAX_EMAILS);
  setSessionState(
    db,
    key,
    JSON.stringify({
      scope,
      ids: readIds,
      ...(prior.selection ? { selection: prior.selection } : {}),
      evidence: {
        emails: bounded,
        omitted: readIds.length - bounded.length,
      },
    }),
  );
}

/** Snapshot before the durable outbound insert, so queue recovery never depends on the mail cache. */
export function prepareScheduledReport(db: Database.Database, msg: WriteOutbound): WriteOutbound {
  // A retried RPC must use the first persisted bytes, including the first evidence snapshot.
  const existing = db.prepare('SELECT * FROM messages_out WHERE id = ?').get(msg.id) as WriteOutbound | undefined;
  if (existing) return existing;
  if (msg.kind !== 'chat') return msg;
  const content = JSON.parse(msg.content) as Record<string, unknown>;
  const ids = content.source_email_ids;
  const findings = content.source_email_findings;
  delete content.source_email_ids;
  delete content.source_email_findings;
  // This field is host-owned; accepting it from the agent would permit invented email evidence.
  delete content.memory_evidence;
  const scheduled = msg.in_reply_to
    ? db.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'task'").get(msg.in_reply_to)
    : undefined;
  if (scheduled && msg.channel_type !== 'agent' && isLearnEnabled(db)) {
    const reads = getSessionState(db, `${READ_PREFIX}${msg.in_reply_to}`);
    const parsedLedger = reads ? (JSON.parse(reads) as ScheduledReads) : undefined;
    const ledger = parsedLedger && parsedLedger.scope !== mailScope() ? undefined : parsedLedger;
    const captured = ledger?.evidence;
    if (Array.isArray(ids) && ids.length > 0) {
      try {
        const originals = new Map(captured?.emails.map((email) => [email.item_id, email]) ?? []);
        const fresh = snapshotEmailEvidence(ids);
        const selected = new Map<string, ScheduledEmailEvidence>();
        const selectedIds = new Set<string>();
        const config = loadMailConfig();
        for (const id of ids) {
          try {
            const decoded = decodeMailId(
              id,
              config.mailboxes.map((mailbox) => mailbox.key),
            );
            const key = `email:${encodeMailId(decoded.mailbox, decoded.gmailId)}`;
            selectedIds.add(key);
            const mailbox = config.mailboxes.find((m) => m.key === decoded.mailbox);
            const requiresRead = (mailbox?.ignoreLabels?.length ?? 0) + (mailbox?.ignoreSenders?.length ?? 0) > 0;
            const readHere = ledger
              ? ledger.ids.includes(encodeMailId(decoded.mailbox, decoded.gmailId))
              : !requiresRead && !parsedLedger;
            const email = readHere
              ? (originals.get(key) ?? fresh.emails.find((item) => item.item_id === key))
              : undefined;
            if (email) selected.set(key, email);
          } catch {
            selectedIds.add(String(id));
          }
        }
        let chars = 0;
        const emails = [...selected.values()]
          .filter((email) => {
            if (chars + email.text.length > MAX_TOTAL_CHARS) return false;
            chars += email.text.length;
            return true;
          })
          .slice(0, MAX_EMAILS);
        const snapshot = { emails, omitted: Math.max(0, selectedIds.size - emails.length) };
        content.memory_evidence = snapshot;
      } catch {
        content.memory_evidence = { emails: [], omitted: ids.length } satisfies ScheduledEvidence;
      }
    } else if (captured) {
      // An explicit empty decision excludes routine mail. Later acknowledgements inherit
      // the report's selection instead of expanding it to every email read during the run.
      content.memory_evidence = Array.isArray(ids) ? { emails: [], omitted: 0 } : (ledger?.selection ?? captured);
    }
    if (findings !== undefined) {
      if (!Array.isArray(findings) || findings.length > 40 || !Array.isArray(ids))
        throw new Error('Invalid source_email_findings');
      const evidence = content.memory_evidence as ScheduledEvidence | undefined;
      const selected = new Set(
        ids
          .filter((id) => typeof id === 'string')
          .map((id) => {
            const decoded = decodeMailId(id);
            return `email:${encodeMailId(decoded.mailbox, decoded.gmailId)}`;
          }),
      );
      const parsed = findings.map((finding) => {
        const visible =
          typeof content.text === 'string'
            ? content.text.replace(/<internal>[\s\S]*?<\/internal>/gi, '').replace(/<\/?message[^>]*>/gi, '')
            : '';
        if (
          !finding ||
          typeof finding.text !== 'string' ||
          !finding.text.trim() ||
          finding.text.length > 3000 ||
          !visible.includes(finding.text) ||
          !Array.isArray(finding.source_email_ids) ||
          !finding.source_email_ids.length ||
          finding.source_email_ids.length > 20
        )
          throw new Error('Each email finding must quote visible report text and name selected original message IDs');
        const item_ids = [
          ...new Set(
            finding.source_email_ids.map((id: unknown) => {
              if (typeof id !== 'string') throw new Error('Invalid finding source ID');
              const decoded = decodeMailId(id);
              const canonical = `email:${encodeMailId(decoded.mailbox, decoded.gmailId)}`;
              if (!selected.has(canonical)) throw new Error('Finding source was not selected');
              return canonical;
            }),
          ),
        ] as string[];
        return { text: finding.text, item_ids };
      });
      const linked = new Set(parsed.flatMap((finding) => finding.item_ids));
      if ([...selected].some((id) => !linked.has(id)))
        throw new Error('Selected originals must all support a personal source_email_finding');
      if (evidence) evidence.findings = parsed;
    }
    if (ledger && Array.isArray(ids)) {
      setSessionState(
        db,
        `${READ_PREFIX}${msg.in_reply_to}`,
        JSON.stringify({
          ...ledger,
          selection: content.memory_evidence as ScheduledEvidence,
        } satisfies ScheduledReads),
      );
    }

    const evidence = content.memory_evidence as ScheduledEvidence;
    if (evidence?.omitted) {
      log.warn('scheduled report source evidence omitted', { reportId: msg.id, count: evidence.omitted });
    }
  }
  return { ...msg, content: JSON.stringify(content) };
}
