/**
 * Reading and writing cached message bodies.
 *
 * What is stored is the *cleaned* body — the one the agent would have been given — plus the raw
 * text it was cleaned from, so `read_message({ raw: true })` is also served from cache and the
 * quote-stripping accounting stays reproducible without a second fetch.
 *
 * What is deliberately not stored: `unread`. Read state changes, and a cached one would be wrong
 * within minutes of the user opening Gmail. Callers merge it in from the live envelope fetch.
 */
import type { AttachmentMeta, Direction, MailMessage, RemovedCounts } from '../types.js';
import { getMailDb } from './db.js';

export interface CachedMessage {
  mailbox: string;
  gmMsgId: string;
  gmThrId: string;
  /** RFC-822 `Message-ID`, for deduping the same mail found in two mailboxes. */
  messageId: string | null;
  internalAt: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  outgoing: boolean;
  bodyClean: string;
  bodyRaw: string | null;
  removed: RemovedCounts;
  attachments: AttachmentMeta[];
}

interface Row {
  mailbox: string;
  gm_msgid: string;
  gm_thrid: string;
  message_id: string | null;
  internal_at: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string;
  subject: string;
  outgoing: number;
  body_clean: string;
  body_raw: string | null;
  removed_json: string;
  attach_json: string;
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toCached(row: Row): CachedMessage {
  let removed: RemovedCounts = { quotedLines: 0, signatureLines: 0, truncatedChars: 0 };
  try {
    removed = { ...removed, ...(JSON.parse(row.removed_json) as Partial<RemovedCounts>) };
  } catch {
    // A row written by an older shape is still a usable body; the counts are the losable part.
  }
  return {
    mailbox: row.mailbox,
    gmMsgId: row.gm_msgid,
    gmThrId: row.gm_thrid,
    messageId: row.message_id,
    internalAt: row.internal_at,
    from: row.from_addr,
    to: parseJsonArray<string>(row.to_addrs),
    cc: parseJsonArray<string>(row.cc_addrs),
    subject: row.subject,
    outgoing: row.outgoing === 1,
    bodyClean: row.body_clean,
    bodyRaw: row.body_raw,
    removed,
    attachments: parseJsonArray<AttachmentMeta>(row.attach_json),
  };
}

export function getCachedMessage(mailbox: string, gmMsgId: string): CachedMessage | null {
  const row = getMailDb().prepare('SELECT * FROM messages WHERE mailbox = ? AND gm_msgid = ?').get(mailbox, gmMsgId) as
    | Row
    | undefined;
  return row ? toCached(row) : null;
}

export function putCachedMessage(message: CachedMessage): void {
  getMailDb()
    .prepare(
      `INSERT INTO messages
         (mailbox, gm_msgid, gm_thrid, message_id, internal_at, from_addr, to_addrs, cc_addrs,
          subject, outgoing, body_clean, body_raw, removed_json, attach_json, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox, gm_msgid) DO UPDATE SET
         body_clean = excluded.body_clean,
         body_raw = excluded.body_raw,
         removed_json = excluded.removed_json,
         attach_json = excluded.attach_json`,
    )
    .run(
      message.mailbox,
      message.gmMsgId,
      message.gmThrId,
      message.messageId,
      message.internalAt,
      message.from,
      JSON.stringify(message.to),
      JSON.stringify(message.cc),
      message.subject,
      message.outgoing ? 1 : 0,
      message.bodyClean,
      message.bodyRaw,
      JSON.stringify(message.removed),
      JSON.stringify(message.attachments),
      new Date().toISOString(),
    );
}

/** Shape a cached row as the tool-facing message. `unread` comes from the live fetch, never here. */
export function toMailMessage(cached: CachedMessage, id: string, threadId: string, unread: boolean): MailMessage {
  const direction: Direction = cached.outgoing ? 'outgoing' : 'incoming';
  return {
    id,
    threadId,
    mailbox: cached.mailbox,
    from: cached.from,
    to: cached.to,
    cc: cached.cc,
    subject: cached.subject,
    date: cached.internalAt,
    direction,
    unread,
    body: cached.bodyClean,
    removed: cached.removed,
    attachments: cached.attachments,
  };
}
