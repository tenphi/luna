/**
 * Ids the agent holds: `<mailbox-key>:<gmail-id-hex>`.
 *
 * The old builtin handed out bare IMAP UIDs, which are scoped to a folder. An id listed from Sent
 * and then passed to a read that defaulted to INBOX did not fail — it silently resolved to
 * *a different message*, because both folders number their messages from one. Every id-taking tool
 * therefore needed a `folder` argument, the skill file needed a section explaining it, and getting
 * it wrong was invisible.
 *
 * Gmail's `X-GM-MSGID` and `X-GM-THRID` are global: one 64-bit id per message and per thread,
 * identical in every folder, and identical to the ids the Gmail REST API returns. Pairing one with
 * the mailbox it came from makes the id fully self-describing, so:
 *
 *   - no tool needs a `mailbox` argument alongside an id, and none can be given a mismatched pair
 *   - an id from a search across every mailbox still says which mailbox to open
 *   - ids survive the swap to the REST API, because they were never IMAP's to begin with
 *
 * Hex rather than decimal because that is the form Gmail's own web UI and the REST API use, so an
 * id in a log or a conversation can be pasted straight into either.
 */

export interface MailId {
  mailbox: string;
  /** Lowercase hex, no `0x`. Gmail's 64-bit message or thread id. */
  gmailId: string;
}

export class MailIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailIdError';
  }
}

/** Roster keys are the mailbox half, and a key with a colon in it would make the id ambiguous. */
const MAILBOX_KEY = /^[A-Za-z0-9._-]+$/;
const GMAIL_ID = /^[0-9a-f]{1,16}$/;

export function encodeMailId(mailbox: string, gmailId: bigint | string): string {
  const hex = typeof gmailId === 'bigint' ? gmailId.toString(16) : gmailId.toLowerCase().replace(/^0x/, '');
  if (!MAILBOX_KEY.test(mailbox)) {
    throw new MailIdError(`Mailbox key ${JSON.stringify(mailbox)} cannot appear in an id`);
  }
  if (!GMAIL_ID.test(hex)) {
    throw new MailIdError(`Not a Gmail id: ${JSON.stringify(String(gmailId))}`);
  }
  return `${mailbox}:${hex}`;
}

/**
 * Parse an id, or say precisely what is wrong with it.
 *
 * `knownMailboxes` is checked when supplied so that an id naming a mailbox this install does not
 * have fails here, with the list of ones it does, rather than as an empty result three calls later
 * that reads as "no such message".
 */
export function decodeMailId(id: string, knownMailboxes?: readonly string[]): MailId {
  const raw = id.trim();
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) {
    throw new MailIdError(
      `${JSON.stringify(id)} is not a mail id. Ids look like "ada:18f2c4a9b0e1" and come from ` +
        `search_mail or read_thread — they are not Gmail web URLs or message subjects.`,
    );
  }

  const mailbox = raw.slice(0, at);
  const gmailId = raw.slice(at + 1).toLowerCase();

  if (!GMAIL_ID.test(gmailId)) {
    throw new MailIdError(`${JSON.stringify(id)} has a malformed Gmail id after the colon`);
  }
  if (knownMailboxes && !knownMailboxes.includes(mailbox)) {
    const known = knownMailboxes.length > 0 ? knownMailboxes.join(', ') : 'none are configured';
    throw new MailIdError(`No mailbox named ${JSON.stringify(mailbox)} — configured mailboxes: ${known}`);
  }
  return { mailbox, gmailId };
}

/** The numeric form IMAP's `X-GM-MSGID` / `X-GM-THRID` search keys want. */
export function toGmailNumeric(gmailId: string): string {
  return BigInt(`0x${gmailId}`).toString(10);
}

/**
 * The hex form, from the decimal string IMAP reports.
 *
 * Gmail's IMAP extensions hand back `X-GM-MSGID` in decimal while its web UI and REST API both use
 * hex for the same number. Normalizing to hex at the edge is what lets an id from this builtin be
 * pasted into a Gmail URL, and what keeps ids stable if the backend is ever swapped for the API.
 */
export function fromGmailNumeric(decimal: string): string {
  return BigInt(decimal).toString(16);
}
