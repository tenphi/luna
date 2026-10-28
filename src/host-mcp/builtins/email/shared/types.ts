export const EMAIL_SERVER_KEY = 'email';

/**
 * One person's mailbox, resolved: config plus the secret from `.env`.
 *
 * `key` is the roster key (`ada`), not an account id. That is the whole point of hanging
 * mailboxes off `users.<key>` — every envelope this builtin returns can name a *person*, so a
 * shared assistant can answer "did either of us get it?" without inventing a second identity
 * namespace that has to be kept in sync with the roster.
 */
export interface Mailbox {
  ignoreLabels?: string[];
  ignoreSenders?: string[];
  key: string;
  address: string;
  displayName: string | null;
  appPassword: string;
}

/** A mailbox that is configured but unusable, and why — so health can say which and how to fix it. */
export interface MailboxProblem {
  key: string;
  reason: 'no_address' | 'no_password' | 'disabled';
  message: string;
}

export interface MailConfig {
  ignoreLabels?: string[];
  ignoreSenders?: string[];
  enabled: boolean;
  backend: 'gmail-imap';
  toolsAllow: string[];
  maxBodyChars: number;
  mailboxes: Mailbox[];
  problems: MailboxProblem[];
}

/** Which way a message went, relative to the mailbox it was found in. */
export type Direction = 'incoming' | 'outgoing';

/**
 * A thread as it appears in a result list. Deliberately without bodies: a search that carried
 * bodies would spend the token budget it exists to protect.
 */
export interface ThreadSummary {
  threadId: string;
  /** RFC-822 Message-ID of the newest matched message, for safe cross-mailbox deduplication. */
  latestMessageId?: string;
  mailbox: string;
  subject: string;
  /** Everyone who appears as From across the thread, deduped, in first-seen order. */
  participants: string[];
  lastMessageAt: string;
  messageCount: number;
  unread: boolean;
  hasAttachments: boolean;
  snippet: string;
  /**
   * Set when the same RFC-822 Message-ID was found in more than one configured mailbox — mail
   * between two roster members is one conversation, not two results.
   */
  alsoIn?: string[];
}

/** What was cut from a body, so a caller can tell a short message from a trimmed one. */
export interface RemovedCounts {
  quotedLines: number;
  signatureLines: number;
  /** Characters dropped by the budget, past whatever quoting removed. */
  truncatedChars: number;
}

export interface MailMessage {
  id: string;
  threadId: string;
  mailbox: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  direction: Direction;
  unread: boolean;
  body: string;
  removed: RemovedCounts;
  attachments: AttachmentMeta[];
}

export interface ThreadDetail {
  threadId: string;
  mailbox: string;
  subject: string;
  messages: MailMessage[];
}

export interface AttachmentMeta {
  /** MIME part path within the message (`2.1`), stable for the life of the message. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

/** A search, before it becomes a Gmail query. */
export interface MailQuery {
  /** Number of globally sorted threads already reviewed. */
  offset?: number;
  /** A roster key, or `'*'` for every configured mailbox. */
  mailbox: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  until?: string;
  direction?: Direction | 'any';
  unreadOnly?: boolean;
  hasAttachment?: boolean;
  limit: number;
}

export interface OutgoingMail {
  mailbox: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Host paths, already translated out of `/workspace` and size-checked by the caller. */
  attachmentPaths?: string[];
  /** Set for a reply: threads the message correctly via In-Reply-To / References. */
  inReplyTo?: { messageId: string; references: string[] };
}

export type MailHealthStatus = 'ok' | 'no_mailboxes' | 'auth_failed' | 'unreachable' | 'disabled';

export interface MailboxHealth {
  key: string;
  address: string;
  ok: boolean;
  detail: string;
}

export interface MailHealth {
  status: MailHealthStatus;
  message: string;
  mailboxes: MailboxHealth[];
  checkedAt: string;
}
