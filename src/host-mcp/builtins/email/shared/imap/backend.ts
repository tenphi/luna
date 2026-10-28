/**
 * Gmail over IMAP, behind `MailBackend`.
 *
 * This is the only file that knows mail arrives over IMAP. Everything it returns is addressed by
 * Gmail's own global ids, so the whole file is replaceable by a REST implementation without a
 * single id, cached row or saved reference going stale.
 */
import type { FetchMessageObject, ImapFlow } from 'imapflow';

import { log } from '../../../../../log.js';
import type { MailBackend } from '../backend.js';
import { budgetBody } from '../clean/budget.js';
import { htmlToText } from '../clean/html-to-text.js';
import { stripQuotes } from '../clean/quotes.js';
import { getCachedMessage, putCachedMessage, toMailMessage, type CachedMessage } from '../cache/messages.js';
import { decodeMailId, encodeMailId, fromGmailNumeric, toGmailNumeric } from '../ids.js';
import type {
  AttachmentMeta,
  MailMessage,
  MailQuery,
  Mailbox,
  MailboxHealth,
  OutgoingMail,
  ThreadDetail,
  ThreadSummary,
} from '../types.js';
import { withMailbox, closeAllMailConnections } from './client.js';
import { buildGmailQuery, dateWindow, hasOwnDateBound, windowedQuery } from './search.js';
import { gmailExclusions, isExcluded } from '../exclusions.js';
import { appendDraft, sendMail } from './send.js';
import { chooseBodyPart, decodeBodyPart, listAttachmentParts } from './structure.js';

/**
 * Recency windows tried in order before falling back to the whole mailbox.
 *
 * Two steps rather than one: a week covers "what came in today", a quarter covers almost everything
 * else anyone asks about, and each failed step costs a cheap search rather than an expensive one.
 */
const RECENCY_WINDOW_DAYS = [7, 90];

/** Envelope metadata for one message, before any body is fetched. */
interface Envelope {
  policyUnavailable: boolean;
  excluded: boolean;
  uid: number;
  gmMsgId: string;
  gmThrId: string;
  messageId: string | null;
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  unread: boolean;
  outgoing: boolean;
  attachments: AttachmentMeta[];
  structure: FetchMessageObject['bodyStructure'];
}

function addressList(list: Array<{ name?: string; address?: string }> | undefined): string[] {
  return (list ?? [])
    .map((a) => {
      const address = a.address ?? '';
      const name = a.name?.trim();
      return name && name !== address ? `${name} <${address}>` : address;
    })
    .filter(Boolean);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase().includes(b.toLowerCase());
}

function toEnvelope(message: FetchMessageObject, mailbox: Mailbox): Envelope | null {
  // Without Gmail's ids there is nothing addressable here — an account with the extension missing
  // is a configuration problem, not a message to half-render.
  if (!message.emailId || !message.threadId) return null;

  const envelope = message.envelope;
  const from = addressList(envelope?.from)[0] ?? '';
  const internalDate = message.internalDate ?? envelope?.date;
  const policyUnavailable =
    Boolean(mailbox.ignoreLabels?.length && !message.labels) ||
    Boolean(mailbox.ignoreSenders?.length && !envelope?.from?.some((sender) => sender.address));

  return {
    policyUnavailable,
    excluded:
      isExcluded(
        mailbox,
        (envelope?.from ?? []).map((sender) => sender.address ?? ''),
        message.labels ?? [],
      ) ||
      policyUnavailable ||
      Boolean(message.flags?.has('\\Draft')) ||
      [...(message.labels ?? [])].some((label) =>
        ['\\Trash', '\\Junk', '\\Spam', '\\Draft', '\\Drafts'].includes(label),
      ),
    uid: message.uid,
    gmMsgId: fromGmailNumeric(message.emailId),
    gmThrId: fromGmailNumeric(message.threadId),
    messageId: envelope?.messageId ?? null,
    date: internalDate ? new Date(internalDate).toISOString() : new Date(0).toISOString(),
    from,
    to: addressList(envelope?.to),
    cc: addressList(envelope?.cc),
    subject: envelope?.subject ?? '(no subject)',
    unread: !message.flags?.has('\\Seen'),
    outgoing: sameAddress(from, mailbox.address),
    attachments: listAttachmentParts(message.bodyStructure),
    structure: message.bodyStructure,
  };
}

const ENVELOPE_QUERY = {
  labels: true,
  uid: true,
  envelope: true,
  flags: true,
  internalDate: true,
  bodyStructure: true,
  threadId: true,
} as const;

/**
 * Fetch the body of one message and clean it.
 *
 * Only the chosen text part is transferred — the attachments named in `BODYSTRUCTURE` stay on the
 * server until something asks for them by name.
 */
async function fetchCleanedBody(
  client: ImapFlow,
  envelope: Envelope,
): Promise<{ clean: string; raw: string; quotedLines: number; signatureLines: number }> {
  const choice = chooseBodyPart(envelope.structure);
  if (!choice) return { clean: '', raw: '', quotedLines: 0, signatureLines: 0 };

  const partKey = choice.part ?? '1';
  const fetched = await client.fetchOne(String(envelope.uid), { uid: true, bodyParts: [partKey] }, { uid: true });
  const buffer = fetched && typeof fetched !== 'boolean' ? fetched.bodyParts?.get(partKey) : undefined;
  if (!buffer) return { clean: '', raw: '', quotedLines: 0, signatureLines: 0 };

  const serverDecoded = fetched && typeof fetched !== 'boolean' ? Boolean(fetched.binaryParts?.has(partKey)) : false;
  const raw = decodeBodyPart(buffer, choice, serverDecoded);

  // HTML is flattened first so that quote stripping sees the same line structure a plain-text part
  // would have had — the two paths converge before anything is counted.
  let text = raw;
  let quotedFromHtml = 0;
  if (choice.type === 'text/html') {
    const converted = htmlToText(raw);
    text = converted.text;
    // A dropped `<blockquote>` is quoting, and saying so keeps the accounting honest even though
    // the exact line count is gone with the markup.
    quotedFromHtml = converted.droppedQuoteContainer ? 1 : 0;
  }

  const stripped = stripQuotes(text);
  return {
    clean: stripped.text,
    raw,
    quotedLines: stripped.quotedLines + quotedFromHtml,
    signatureLines: stripped.signatureLines,
  };
}

/** Cache-first body resolution: only a miss costs a fetch. */
async function resolveMessage(client: ImapFlow, mailbox: Mailbox, envelope: Envelope): Promise<CachedMessage> {
  const hit = getCachedMessage(mailbox.key, envelope.gmMsgId);
  if (hit) return hit;

  const body = await fetchCleanedBody(client, envelope);
  const record: CachedMessage = {
    mailbox: mailbox.key,
    gmMsgId: envelope.gmMsgId,
    gmThrId: envelope.gmThrId,
    messageId: envelope.messageId,
    internalAt: envelope.date,
    from: envelope.from,
    to: envelope.to,
    cc: envelope.cc,
    subject: envelope.subject,
    outgoing: envelope.outgoing,
    bodyClean: body.clean,
    bodyRaw: body.raw,
    removed: { quotedLines: body.quotedLines, signatureLines: body.signatureLines, truncatedChars: 0 },
    attachments: envelope.attachments,
  };
  putCachedMessage(record);
  return record;
}

/** Newest first, which is the order every question about mail is asked in. */
function byDateDesc(a: { date: string }, b: { date: string }): number {
  return b.date.localeCompare(a.date);
}

export class GmailImapBackend implements MailBackend {
  constructor(private readonly mailboxes: Mailbox[]) {}

  private mailbox(key: string): Mailbox {
    const found = this.mailboxes.find((m) => m.key === key);
    if (!found) throw new Error(`No mailbox named ${JSON.stringify(key)}`);
    return found;
  }

  async probe(mailboxKey: string): Promise<MailboxHealth> {
    const mailbox = this.mailbox(mailboxKey);
    try {
      const count = await withMailbox(mailbox, async ({ mailbox: open }) => open.exists);
      return { key: mailbox.key, address: mailbox.address, ok: true, detail: `${count} messages in All Mail` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Gmail's wording for a bad app password is unhelpfully generic, so name the likely fix.
      const detail = /AUTHENTICATIONFAILED|Invalid credentials/i.test(message)
        ? `authentication failed — the app password for ${mailbox.address} is wrong or was revoked`
        : message;
      return { key: mailbox.key, address: mailbox.address, ok: false, detail };
    }
  }

  async searchThreads(query: MailQuery): Promise<ThreadSummary[]> {
    return (await this.searchThreadsWithCoverage(query)).threads;
  }

  async searchThreadsWithCoverage(query: MailQuery): Promise<{
    threads: ThreadSummary[];
    matchedMessages: number;
    examinedMessages: number;
    complete: boolean;
  }> {
    const mailbox = this.mailbox(query.mailbox);
    const window = dateWindow(query);

    // Messages, not threads: several messages of one conversation collapse into one row, so asking
    // for `limit` threads means fetching well past `limit` envelopes.
    const messagePool = query.limit * 6;

    return withMailbox(mailbox, async ({ client }) => {
      const collect = async (
        gmailQuery: string,
      ): Promise<{
        threads: ThreadSummary[];
        poolWasFull: boolean;
        matchedMessages: number;
        examinedMessages: number;
        metadataUnavailable: number;
      }> => {
        const uids = await client.search({ gmraw: `${gmailQuery} ${gmailExclusions(mailbox)}`.trim() }, { uid: true });
        if (!uids || uids.length === 0) {
          return { threads: [], poolWasFull: false, matchedMessages: 0, examinedMessages: 0, metadataUnavailable: 0 };
        }

        // Search returns ascending UIDs, so the newest matches are at the end.
        const envelopes: Envelope[] = [];
        let examined = 0;
        let metadataUnavailable = 0;
        let threads: ThreadSummary[] = [];
        while (examined < uids.length) {
          const chunk = uids.slice(Math.max(0, uids.length - examined - messagePool), uids.length - examined);
          for await (const message of client.fetch(chunk, ENVELOPE_QUERY, { uid: true })) {
            const envelope = toEnvelope(message, mailbox);
            if (!envelope || envelope.policyUnavailable) {
              metadataUnavailable++;
              continue;
            }
            if (
              !envelope.excluded &&
              (window.start === undefined || Date.parse(envelope.date) >= window.start * 1000) &&
              (window.end === undefined || Date.parse(envelope.date) < window.end * 1000)
            )
              envelopes.push(envelope);
          }
          examined += chunk.length;
          threads = this.groupIntoThreads(envelopes, mailbox.key);
          if (threads.length >= query.limit) break;
        }
        return {
          threads,
          poolWasFull: examined < uids.length,
          matchedMessages: examined === uids.length ? envelopes.length : -1,
          examinedMessages: envelopes.length,
          metadataUnavailable,
        };
      };

      // Recent first, whole mailbox only if the window genuinely ran out of mail. See
      // `windowedQuery`: an unbounded IMAP search transfers every matching id, seconds on a large
      // mailbox.
      //
      // Scan enough envelopes to find the requested distinct threads, even if a single busy
      // conversation fills several chunks. Once enough threads exist, older windows cannot
      // displace those newest-first results; only widen when this window was exhausted.
      if (!hasOwnDateBound(query)) {
        for (const days of RECENCY_WINDOW_DAYS) {
          const { threads, poolWasFull } = await collect(windowedQuery(query, days));
          if (poolWasFull || threads.length >= query.limit) {
            return {
              threads: threads.slice(0, query.limit),
              matchedMessages: -1,
              examinedMessages: -1,
              complete: false,
            };
          }
        }
        log.debug('mail search widening past the recency windows', { mailbox: mailbox.key });
      }

      const result = await collect(buildGmailQuery(query));
      return {
        threads: result.threads.slice(0, query.limit),
        matchedMessages: result.matchedMessages,
        examinedMessages: result.examinedMessages,
        complete:
          result.metadataUnavailable === 0 &&
          result.examinedMessages === result.matchedMessages &&
          result.threads.length <= query.limit,
      };
    });
  }

  private groupIntoThreads(envelopes: Envelope[], mailboxKey: string): ThreadSummary[] {
    const byThread = new Map<string, Envelope[]>();
    for (const envelope of envelopes) {
      const bucket = byThread.get(envelope.gmThrId);
      if (bucket) bucket.push(envelope);
      else byThread.set(envelope.gmThrId, [envelope]);
    }

    const threads: ThreadSummary[] = [];
    for (const [gmThrId, group] of byThread) {
      group.sort(byDateDesc);
      const newest = group[0]!;
      const participants: string[] = [];
      for (const item of [...group].reverse()) {
        if (item.from && !participants.includes(item.from)) participants.push(item.from);
      }

      threads.push({
        threadId: encodeMailId(mailboxKey, gmThrId),
        ...(newest.messageId ? { latestMessageId: newest.messageId } : {}),
        mailbox: mailboxKey,
        subject: newest.subject,
        participants,
        lastMessageAt: newest.date,
        // The count is of matched messages, not of the whole thread — search returned what matched,
        // and claiming a full thread count here would be a number we did not measure.
        messageCount: group.length,
        unread: group.some((m) => m.unread),
        hasAttachments: group.some((m) => m.attachments.length > 0),
        snippet: '',
      });
    }

    return threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  async readThread(threadId: string, maxBodyChars: number): Promise<ThreadDetail> {
    const { mailbox: key, gmailId } = decodeMailId(threadId);
    const mailbox = this.mailbox(key);

    return withMailbox(mailbox, async ({ client }) => {
      const uids = await client.search({ threadId: toGmailNumeric(gmailId) }, { uid: true });
      if (!uids || uids.length === 0) {
        throw new Error(`No thread ${threadId}. Thread ids come from search_mail and are not Gmail web URLs.`);
      }

      const envelopes: Envelope[] = [];
      for await (const message of client.fetch(uids, ENVELOPE_QUERY, { uid: true })) {
        const envelope = toEnvelope(message, mailbox);
        if (envelope) envelopes.push(envelope);
      }
      envelopes.sort((a, b) => a.date.localeCompare(b.date));

      const messages: MailMessage[] = [];
      for (const envelope of envelopes) {
        if (envelope.excluded) continue;
        const cached = await resolveMessage(client, mailbox, envelope);
        const id = encodeMailId(key, envelope.gmMsgId);
        const budgeted = budgetBody(cached.bodyClean, maxBodyChars, id);
        const message = toMailMessage(cached, id, threadId, envelope.unread);
        messages.push({
          ...message,
          body: budgeted.text,
          removed: { ...cached.removed, truncatedChars: budgeted.truncatedChars },
        });
      }

      if (messages.length === 0) throw new Error('This thread is excluded by email settings.');

      return {
        threadId,
        mailbox: key,
        subject: messages[messages.length - 1]?.subject ?? '(no subject)',
        messages,
      };
    });
  }

  async readMessage(
    messageId: string,
    opts: { maxBodyChars: number; offset?: number; raw?: boolean },
  ): Promise<MailMessage> {
    const { mailbox: key, gmailId } = decodeMailId(messageId);
    const mailbox = this.mailbox(key);

    return withMailbox(mailbox, async ({ client }) => {
      const envelope = await this.findByGmailId(client, mailbox, gmailId);
      const cached = await resolveMessage(client, mailbox, envelope);
      const threadId = encodeMailId(key, envelope.gmThrId);
      const base = toMailMessage(cached, messageId, threadId, envelope.unread);

      // `raw` is the escape hatch from every cleaning decision this builtin makes — it must not be
      // budgeted or stripped, or it could not serve as the check on them.
      if (opts.raw) {
        return { ...base, body: cached.bodyRaw ?? cached.bodyClean, removed: { ...cached.removed, truncatedChars: 0 } };
      }

      const offset = Math.max(0, opts.offset ?? 0);
      const budgeted = budgetBody(cached.bodyClean.slice(offset), opts.maxBodyChars, messageId, offset);
      return {
        ...base,
        body: budgeted.text,
        removed: { ...cached.removed, truncatedChars: budgeted.truncatedChars },
      };
    });
  }

  private async findByGmailId(client: ImapFlow, mailbox: Mailbox, gmailId: string): Promise<Envelope> {
    const uids = await client.search({ emailId: toGmailNumeric(gmailId) }, { uid: true });
    if (!uids || uids.length === 0) {
      throw new Error(
        `No message ${encodeMailId(mailbox.key, gmailId)} in ${mailbox.address}. ` +
          `Ids come from search_mail or read_thread.`,
      );
    }
    const fetched = await client.fetchOne(String(uids[uids.length - 1]), ENVELOPE_QUERY, { uid: true });
    const envelope = fetched && typeof fetched !== 'boolean' ? toEnvelope(fetched, mailbox) : null;
    if (!envelope) throw new Error(`Message ${encodeMailId(mailbox.key, gmailId)} could not be read`);
    if (envelope.excluded) throw new Error('This message is excluded by email settings.');
    return envelope;
  }

  async listAttachments(messageId: string): Promise<AttachmentMeta[]> {
    const { mailbox: key, gmailId } = decodeMailId(messageId);
    const mailbox = this.mailbox(key);
    return withMailbox(mailbox, async ({ client }) => {
      const envelope = await this.findByGmailId(client, mailbox, gmailId);
      return envelope.attachments;
    });
  }

  async fetchAttachment(messageId: string, attachmentId: string): Promise<{ meta: AttachmentMeta; bytes: Buffer }> {
    const { mailbox: key, gmailId } = decodeMailId(messageId);
    const mailbox = this.mailbox(key);

    return withMailbox(mailbox, async ({ client }) => {
      const envelope = await this.findByGmailId(client, mailbox, gmailId);
      const meta = envelope.attachments.find((a) => a.attachmentId === attachmentId);
      if (!meta) {
        const known = envelope.attachments.map((a) => `${a.attachmentId} (${a.filename})`).join(', ') || 'none';
        throw new Error(`No attachment ${attachmentId} on ${messageId}. Available: ${known}`);
      }

      const downloaded = await client.download(String(envelope.uid), attachmentId, { uid: true });
      if (!downloaded?.content) throw new Error(`Attachment ${meta.filename} could not be downloaded`);

      const chunks: Buffer[] = [];
      for await (const chunk of downloaded.content) chunks.push(chunk as Buffer);
      return { meta, bytes: Buffer.concat(chunks) };
    });
  }

  async createDraft(mail: OutgoingMail): Promise<{ webUrl: string }> {
    return appendDraft(this.mailbox(mail.mailbox), mail);
  }

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    return sendMail(this.mailbox(mail.mailbox), mail);
  }

  /**
   * The headers that make a reply thread, and the recipients it should go to.
   *
   * Taken from the newest message in the thread: `In-Reply-To` is its `Message-ID`, and
   * `References` is the chain so far with that id appended — which is what every other mail client
   * will look at to decide where the reply belongs.
   *
   * `replyAll` deliberately drops the sender's own address from the recipients. Leaving it in mails
   * the person a copy of their own reply, which reads as a bug to them and as noise to everyone on
   * the thread.
   */
  async replyContext(
    threadId: string,
    replyAll: boolean,
  ): Promise<{ to: string[]; cc: string[]; subject: string; inReplyTo: OutgoingMail['inReplyTo'] }> {
    const { mailbox: key, gmailId } = decodeMailId(threadId);
    const mailbox = this.mailbox(key);

    return withMailbox(mailbox, async ({ client }) => {
      const uids = await client.search({ threadId: toGmailNumeric(gmailId) }, { uid: true });
      if (!uids || uids.length === 0) throw new Error(`No thread ${threadId}`);

      const messages: Array<{ envelope: Envelope; references: string[] }> = [];
      for await (const message of client.fetch(uids, { ...ENVELOPE_QUERY, headers: ['references'] }, { uid: true })) {
        const envelope = toEnvelope(message, mailbox);
        if (!envelope || envelope.excluded) continue;
        const headerText = message.headers?.toString('utf-8') ?? '';
        const references = headerText.match(/<[^>\s]+>/g) ?? [];
        messages.push({ envelope, references });
      }
      messages.sort((a, b) => a.envelope.date.localeCompare(b.envelope.date));

      const newest = messages[messages.length - 1];
      if (!newest) throw new Error(`No readable message in thread ${threadId}`);

      const mine = mailbox.address.toLowerCase();
      const isMine = (address: string) => address.toLowerCase().includes(mine);

      const to = newest.envelope.outgoing ? newest.envelope.to : [newest.envelope.from];
      const cc = replyAll
        ? [...newest.envelope.to, ...newest.envelope.cc].filter((a) => !isMine(a) && !to.includes(a))
        : [];

      const messageId = newest.envelope.messageId;
      const subject = /^re:/i.test(newest.envelope.subject)
        ? newest.envelope.subject
        : `Re: ${newest.envelope.subject}`;

      return {
        to: to.filter(Boolean),
        cc,
        subject,
        inReplyTo: messageId ? { messageId, references: [...newest.references, messageId] } : undefined,
      };
    });
  }

  async markRead(threadId: string, read: boolean): Promise<void> {
    const { mailbox: key, gmailId } = decodeMailId(threadId);
    const mailbox = this.mailbox(key);
    await withMailbox(mailbox, async ({ client }) => {
      const uids = await this.accessibleThreadUids(client, mailbox, gmailId);
      if (read) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
    });
  }

  async archive(threadId: string): Promise<void> {
    const { mailbox: key, gmailId } = decodeMailId(threadId);
    const mailbox = this.mailbox(key);
    await withMailbox(mailbox, async ({ client }) => {
      const uids = await this.accessibleThreadUids(client, mailbox, gmailId);
      // Archiving in Gmail is removing the Inbox label, not moving anything. Deliberately not a
      // delete: the thread stays in All Mail and this stays reversible from the Gmail UI.
      await client.messageFlagsRemove(uids, ['\\Inbox'], { uid: true, useLabels: true });
      log.info('mail thread archived', { threadId });
    });
  }

  async close(): Promise<void> {
    await closeAllMailConnections();
  }

  private async accessibleThreadUids(client: ImapFlow, mailbox: Mailbox, gmailId: string): Promise<number[]> {
    const ids = await client.search({ threadId: toGmailNumeric(gmailId) }, { uid: true });
    const permitted: number[] = [];
    if (ids && ids.length)
      for await (const message of client.fetch(ids, ENVELOPE_QUERY, { uid: true })) {
        const envelope = toEnvelope(message, mailbox);
        if (envelope && !envelope.excluded) permitted.push(envelope.uid);
      }
    if (!permitted.length)
      throw new Error('No accessible message in this thread; it may be excluded by email settings.');
    return permitted;
  }
}
