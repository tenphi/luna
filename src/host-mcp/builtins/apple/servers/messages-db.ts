/**
 * Read-only access to the Apple Messages SQLite store (`~/Library/Messages/chat.db`).
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-messages-mcp` 1.0.0),
 * vendored in-tree by Luna. The `attributedBody` decoder here is Luna's fixed
 * implementation: modern iMessage rows leave `message.text` NULL and store the
 * body only in the `attributedBody` typedstream blob. The upstream decoder
 * truncated bodies > 127 bytes and corrupted trailing emoji; this version reads
 * the full length-prefixed UTF-8 payload.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');

// Apple's epoch: 2001-01-01 00:00:00 UTC. Offset from Unix epoch in seconds.
const APPLE_EPOCH_OFFSET = 978307200;

// Apple timestamps in chat.db are nanoseconds since 2001-01-01 and exceed
// Number.MAX_SAFE_INTEGER, so convert in SQL to avoid BigInt errors.
const DATE_SQL = (col: string): string => `datetime(${col} / 1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch')`;

export interface ChatSummary {
  chat_id: string;
  display_name: string | null;
  last_message_date: string | null;
  last_message_text: string | null;
}

export interface ChatMessage {
  rowid: number;
  text: string | null;
  is_from_me: boolean;
  date: string | null;
  sender: string | null;
  service?: string | null;
  chat_id?: string;
}

export interface ChatParticipant {
  handle_id: string;
  service: string;
}

/**
 * Decode a length-prefixed UTF-8 string starting at `pos` in a typedstream blob.
 *
 * Length encoding after the payload marker:
 * - byte < 0x80: that byte is the length
 * - 0x81: next 2 bytes are a little-endian uint16 length (strings > 127 bytes)
 * - 0x82: next 4 bytes are a little-endian uint32 length
 * - other high-bit bytes: low nibble = count of following little-endian length bytes
 */
function decodeLengthPrefixedUtf8(buf: Buffer, pos: number): string | null {
  if (pos >= buf.length) return null;
  const lengthByte = buf[pos];
  let textLength: number;
  let textStart: number;
  if (lengthByte < 0x80) {
    textLength = lengthByte;
    textStart = pos + 1;
  } else if (lengthByte === 0x81) {
    if (pos + 3 > buf.length) return null;
    textLength = buf[pos + 1] | (buf[pos + 2] << 8);
    textStart = pos + 3;
  } else if (lengthByte === 0x82) {
    if (pos + 5 > buf.length) return null;
    textLength = buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24);
    textStart = pos + 5;
  } else {
    const numLengthBytes = lengthByte & 0x0f;
    if (numLengthBytes === 0 || pos + 1 + numLengthBytes > buf.length) return null;
    textLength = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      textLength |= buf[pos + 1 + i] << (8 * i);
    }
    textStart = pos + 1 + numLengthBytes;
  }
  if (textStart >= buf.length) return null;
  if (textStart + textLength > buf.length) {
    textLength = buf.length - textStart;
  }
  if (textLength <= 0) return null;
  // Length-delimited payload is the full UTF-8 string — do not strip trailing
  // archive marker bytes here (they sit outside this range; stripping 0x87
  // would corrupt emoji such as 🥇).
  return buf.subarray(textStart, textStart + textLength).toString('utf-8');
}

/**
 * Extract plain text from an NSAttributedString binary blob (attributedBody).
 * Prefer the `0x84 0x01 0x2b` payload marker; fall back to a fixed offset after
 * the `NSString` class name.
 */
export function extractTextFromAttributedBody(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const payloadMarker = Buffer.from([0x84, 0x01, 0x2b]);
  const payloadIdx = buf.indexOf(payloadMarker);
  if (payloadIdx !== -1) {
    return decodeLengthPrefixedUtf8(buf, payloadIdx + payloadMarker.length);
  }
  const nsMarker = Buffer.from('NSString');
  const nsIdx = buf.indexOf(nsMarker);
  if (nsIdx === -1) return null;
  return decodeLengthPrefixedUtf8(buf, nsIdx + nsMarker.length + 5);
}

/** Prefer the plain text column, falling back to attributedBody blob parsing. */
export function getMessageText(text: string | null, attributedBody: Buffer | Uint8Array | null): string | null {
  if (text) return text;
  return extractTextFromAttributedBody(attributedBody);
}

function openDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

interface RawChatRow {
  chat_id: string;
  display_name: string | null;
  last_message_date: string | null;
  text: string | null;
  attributedBody: Buffer | null;
}

export function listChats(limit = 50): ChatSummary[] {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `
      SELECT
        c.chat_identifier as chat_id,
        c.display_name,
        ${DATE_SQL('m.date')} as last_message_date,
        m.text,
        m.attributedBody
      FROM chat c
      LEFT JOIN (
        SELECT
          cmj.chat_id,
          m.date,
          m.text,
          m.attributedBody,
          ROW_NUMBER() OVER (PARTITION BY cmj.chat_id ORDER BY m.date DESC) as rn
        FROM chat_message_join cmj
        JOIN message m ON m.ROWID = cmj.message_id
      ) m ON m.chat_id = c.ROWID AND m.rn = 1
      ORDER BY m.date DESC NULLS LAST
      LIMIT ?
    `,
      )
      .all(limit) as unknown as RawChatRow[];
    return rows.map((row) => ({
      chat_id: row.chat_id,
      display_name: row.display_name || null,
      last_message_date: row.last_message_date,
      last_message_text: getMessageText(row.text, row.attributedBody),
    }));
  } finally {
    db.close();
  }
}

interface RawMessageRow {
  rowid: number;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: number;
  date: string | null;
  service?: string | null;
  sender: string | null;
  chat_id?: string;
}

export function getChatMessages(chatId: string, limit = 100, fromDate?: string, toDate?: string): ChatMessage[] {
  const db = openDb();
  try {
    let dateFilter = '';
    const params: Array<string | number> = [chatId];
    if (fromDate) {
      const fromUnix = new Date(fromDate).getTime() / 1000;
      const fromApple = (fromUnix - APPLE_EPOCH_OFFSET) * 1e9;
      dateFilter += ' AND m.date >= ?';
      params.push(fromApple);
    }
    if (toDate) {
      const toUnix = new Date(toDate).getTime() / 1000;
      const toApple = (toUnix - APPLE_EPOCH_OFFSET) * 1e9;
      dateFilter += ' AND m.date <= ?';
      params.push(toApple);
    }
    params.push(limit);
    const rows = db
      .prepare(
        `
      SELECT
        m.ROWID as rowid,
        m.text,
        m.attributedBody,
        m.is_from_me,
        ${DATE_SQL('m.date')} as date,
        m.service,
        h.id as sender
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE c.chat_identifier = ?${dateFilter}
      ORDER BY m.date DESC
      LIMIT ?
    `,
      )
      .all(...params) as unknown as RawMessageRow[];
    return rows.map((row) => ({
      rowid: row.rowid,
      text: getMessageText(row.text, row.attributedBody),
      is_from_me: row.is_from_me === 1,
      date: row.date,
      sender: row.sender,
      service: row.service,
    }));
  } finally {
    db.close();
  }
}

export function searchMessages(query: string, chatId?: string, limit = 50): ChatMessage[] {
  const db = openDb();
  try {
    const likePattern = `%${query}%`;
    let sql: string;
    let params: Array<string | number>;
    if (chatId) {
      sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE_SQL('m.date')} as date,
          h.id as sender,
          c.chat_identifier as chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE c.chat_identifier = ?
          AND (m.text LIKE ? OR m.attributedBody LIKE ?)
        ORDER BY m.date DESC
        LIMIT ?
      `;
      params = [chatId, likePattern, likePattern, limit];
    } else {
      sql = `
        SELECT
          m.ROWID as rowid,
          m.text,
          m.attributedBody,
          m.is_from_me,
          ${DATE_SQL('m.date')} as date,
          h.id as sender,
          c.chat_identifier as chat_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.text LIKE ? OR m.attributedBody LIKE ?
        ORDER BY m.date DESC
        LIMIT ?
      `;
      params = [likePattern, likePattern, limit];
    }
    const rows = db.prepare(sql).all(...params) as unknown as RawMessageRow[];
    return rows.map((row) => ({
      rowid: row.rowid,
      text: getMessageText(row.text, row.attributedBody),
      is_from_me: row.is_from_me === 1,
      date: row.date,
      sender: row.sender,
      chat_id: row.chat_id,
    }));
  } finally {
    db.close();
  }
}

export function getChatParticipants(chatId: string): ChatParticipant[] {
  const db = openDb();
  try {
    return db
      .prepare(
        `
      SELECT
        h.id as handle_id,
        h.service
      FROM handle h
      JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      JOIN chat c ON c.ROWID = chj.chat_id
      WHERE c.chat_identifier = ?
    `,
      )
      .all(chatId) as unknown as ChatParticipant[];
  } finally {
    db.close();
  }
}
