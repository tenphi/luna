/**
 * The IMAP connection, one per mailbox, held open.
 *
 * Gmail's IMAP endpoint costs a TLS handshake plus an authentication round trip — around a second
 * cold. An assistant asks several questions about mail in a row, so a connection per call would pay
 * that on every one. Connections are therefore cached per mailbox and reopened only after they die.
 *
 * Everything is addressed inside **All Mail**, located by its `\All` special-use flag rather than by
 * the name `[Gmail]/All Mail`, which is localized and differs per account. One open mailbox is what
 * makes the folder-free model work: All Mail holds inbox, sent and archived messages alike, and
 * excludes Spam and Trash — so the folder the client opens already carries the boundary the query
 * builder also enforces.
 */
import { ImapFlow, type MailboxObject } from 'imapflow';

import { log } from '../../../../../log.js';
import type { Mailbox } from '../types.js';

const HOST = 'imap.gmail.com';
const PORT = 993;

/**
 * A test must never open a socket to a real mailbox.
 *
 * The memory client carries the same refusal, for a reason worth repeating here: a unit test
 * reached a live service because only its config was mocked, and it wrote into the operator's real
 * knowledge base. Nothing failed, so nothing said so. The equivalent mistake here reads — or worse,
 * sends — real mail, and any file can make it by importing the wrong module. So the refusal lives
 * at the socket rather than in each test's mock list.
 */
function refuseInTests(): void {
  if (process.env.VITEST && process.env.LUNA_ALLOW_REAL_MAIL !== '1') {
    throw new Error(
      'refusing to open a real IMAP connection from a test — mock the backend, or set LUNA_ALLOW_REAL_MAIL=1',
    );
  }
}

interface Held {
  client: ImapFlow;
  allMailPath: string;
}

const held = new Map<string, Held>();

/** Gmail's All Mail, by special-use flag. Falls back to the English name only if the flag is absent. */
async function findAllMail(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const byFlag = boxes.find((b) => b.specialUse === '\\All');
  if (byFlag) return byFlag.path;

  const byName = boxes.find((b) => b.path === '[Gmail]/All Mail');
  if (byName) return byName.path;

  throw new Error(
    'This account has no All Mail folder. In Gmail: Settings → Forwarding and POP/IMAP → enable IMAP, ' +
      'and Settings → Labels → make sure "All Mail" is shown in IMAP.',
  );
}

async function connect(mailbox: Mailbox): Promise<Held> {
  refuseInTests();

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: mailbox.address, pass: mailbox.appPassword },
    // imapflow logs every command at info by default, which at this volume buries everything else.
    logger: false,
    // Gmail drops idle connections; the client reconnects rather than surfacing a socket error.
    emitLogs: false,
  });

  // An unhandled 'error' on the underlying socket takes the host process down with it. A dropped
  // mail connection is a thing to reopen on the next call, not a reason to stop answering messages.
  client.on('error', (err: unknown) => {
    log.warn('mail connection error', { mailbox: mailbox.key, err: err instanceof Error ? err.message : String(err) });
    held.delete(mailbox.key);
  });

  await client.connect();
  const allMailPath = await findAllMail(client);
  log.info('mail connected', { mailbox: mailbox.key, address: mailbox.address });
  return { client, allMailPath };
}

async function handle(mailbox: Mailbox): Promise<Held> {
  const existing = held.get(mailbox.key);
  if (existing?.client.usable) return existing;

  held.delete(mailbox.key);
  const fresh = await connect(mailbox);
  held.set(mailbox.key, fresh);
  return fresh;
}

export interface MailSession {
  client: ImapFlow;
  path: string;
  mailbox: MailboxObject;
}

/**
 * Run `work` with All Mail open and locked.
 *
 * The lock is imapflow's own mutex: IMAP has one selected folder per connection, so two concurrent
 * fetches on one connection would interleave and read each other's mailbox. A fan-out search across
 * several mailboxes is still fully concurrent — those are different connections.
 *
 * One retry, and only on a dead connection: a socket that died between calls says nothing about
 * whether anything happened, and every read here is safe to repeat. Callers that write do not use
 * this path.
 */
export async function withMailbox<T>(mailbox: Mailbox, work: (session: MailSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { client, allMailPath } = await handle(mailbox);
    const lock = await client.getMailboxLock(allMailPath);
    try {
      return await work({ client, path: allMailPath, mailbox: client.mailbox as MailboxObject });
    } catch (err) {
      if (attempt === 0 && !client.usable) {
        held.delete(mailbox.key);
        log.warn('mail connection died mid-read — reopening', { mailbox: mailbox.key });
        continue;
      }
      throw err;
    } finally {
      lock.release();
    }
  }
  throw new Error(`Could not keep a connection to ${mailbox.address} open`);
}

/**
 * A connection with no folder selected, for commands that name their own target.
 *
 * `append` (drafts) takes a path, so selecting All Mail first would be wrong as well as wasteful.
 */
export async function withConnection<T>(mailbox: Mailbox, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { client } = await handle(mailbox);
  return work(client);
}

/** Close everything. Called on host shutdown so Gmail sees a clean logout rather than a timeout. */
export async function closeAllMailConnections(): Promise<void> {
  const open = [...held.values()];
  held.clear();
  await Promise.all(open.map((h) => h.client.logout().catch(() => {})));
}
