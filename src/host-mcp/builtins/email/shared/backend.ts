import type {
  AttachmentMeta,
  MailMessage,
  MailQuery,
  MailboxHealth,
  OutgoingMail,
  ThreadDetail,
  ThreadSummary,
} from './types.js';

/**
 * What the tools are allowed to know about how mail is fetched.
 *
 * There is one implementation today — Gmail over IMAP, authenticated by an app password — and this
 * interface exists because there will not always be. Google has been retiring password
 * authentication for years, and the replacement is the Gmail REST API with OAuth. That swap should
 * cost one file, not a rewrite, so nothing above this line may mention IMAP, folders, UIDs or
 * connections.
 *
 * The ids crossing this boundary make that possible: they carry Gmail's own `X-GM-MSGID` and
 * `X-GM-THRID`, which are byte-identical to the message and thread ids the REST API returns. A
 * cached message, a saved id in a conversation, a reply the agent is composing — all of them stay
 * valid across the backend swap, because they were never IMAP's ids to begin with.
 */
export interface MailBackend {
  /** Reachability for one mailbox, for health output. Never throws. */
  probe(mailboxKey: string): Promise<MailboxHealth>;

  searchThreads(query: MailQuery): Promise<ThreadSummary[]>;
  /** Exact-window coverage for digests; older backends may report unknown through the tool. */
  searchThreadsWithCoverage?(query: MailQuery): Promise<{
    threads: ThreadSummary[];
    matchedMessages: number;
    examinedMessages: number;
    complete: boolean;
  }>;
  readThread(threadId: string, maxBodyChars: number): Promise<ThreadDetail>;
  /** `offset` continues a body the budget truncated; `raw` returns it unstripped and unbudgeted. */
  readMessage(messageId: string, opts: { maxBodyChars: number; offset?: number; raw?: boolean }): Promise<MailMessage>;

  listAttachments(messageId: string): Promise<AttachmentMeta[]>;
  fetchAttachment(messageId: string, attachmentId: string): Promise<{ meta: AttachmentMeta; bytes: Buffer }>;

  createDraft(mail: OutgoingMail): Promise<{ webUrl: string }>;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  /** Recipients, subject and threading headers for a reply to a thread. */
  replyContext(
    threadId: string,
    replyAll: boolean,
  ): Promise<{ to: string[]; cc: string[]; subject: string; inReplyTo: OutgoingMail['inReplyTo'] }>;

  markRead(threadId: string, read: boolean): Promise<void>;
  archive(threadId: string): Promise<void>;

  /** Release every open connection. Called on host shutdown. */
  close(): Promise<void>;
}
