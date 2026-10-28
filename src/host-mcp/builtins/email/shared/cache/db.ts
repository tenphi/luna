/**
 * The mail cache: a store for the parts of a message that can never change.
 *
 * **Why this needs no invalidation.** A delivered message is immutable — Gmail never rewrites the
 * headers or the body of a message that has arrived. What *does* change is everything around it:
 * labels, read state, which threads it belongs to. So the cache holds only the first kind, and the
 * second kind is fetched live on every call and never written here. There is no staleness window,
 * no TTL, no revalidation, and no way for a cached row to disagree with the server — because the
 * only rows are ones the server has promised not to change.
 *
 * That is also why the cache is worth having at all. `read_thread` on a long conversation is a
 * dozen body fetches over IMAP, and re-reading the same thread later is the common case for an
 * assistant. Bodies are the expensive part and the fixed part at once.
 *
 * Its own database rather than a table in `luna.db`: this is a disposable derivative of a remote
 * mailbox. Deleting the file costs one slow re-read, and nothing else in the install cares — which
 * would not be true of a table sharing a file with the roster and the session index.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../../../config.js';
import { log } from '../../../../../log.js';

let cached: Database.Database | null = null;

export function mailDbPath(): string {
  return path.join(DATA_DIR, 'mail', 'mail.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  mailbox      TEXT NOT NULL,
  gm_msgid     TEXT NOT NULL,
  gm_thrid     TEXT NOT NULL,
  message_id   TEXT,
  internal_at  TEXT NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addrs     TEXT NOT NULL,
  cc_addrs     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  outgoing     INTEGER NOT NULL,
  body_clean   TEXT NOT NULL,
  body_raw     TEXT,
  removed_json TEXT NOT NULL,
  attach_json  TEXT NOT NULL,
  cached_at    TEXT NOT NULL,
  PRIMARY KEY (mailbox, gm_msgid)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(mailbox, gm_thrid, internal_at);

-- Extracted attachment text, keyed by content rather than by message: the same PDF forwarded three
-- times is one row and one extraction, and a forward costs nothing after the first read.
CREATE TABLE IF NOT EXISTS attachment_text (
  sha256       TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  text         TEXT NOT NULL,
  method       TEXT NOT NULL,
  extracted_at TEXT NOT NULL
);
`;

export function getMailDb(): Database.Database {
  if (cached) return cached;

  const dbPath = mailDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  cached = db;
  log.debug('mail cache opened', { path: dbPath });
  return db;
}

/** For tests: an in-memory cache with the same schema, so nothing touches `data/`. */
export function useInMemoryMailDb(): Database.Database {
  cached?.close();
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  cached = db;
  return db;
}

export function closeMailDb(): void {
  cached?.close();
  cached = null;
}
