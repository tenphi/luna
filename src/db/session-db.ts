/**
 * SQL operations on the per-session `session.db`.
 *
 * This is NOT the central app DB. It's the single per-session SQLite file the
 * host owns exclusively (local disk). The container never opens it — it
 * reaches this state over HTTP through the Session API (src/host-mcp/session-api.ts),
 * which calls the functions here. Because the host is the sole opener there is
 * no cross-mount coherency problem, one monotonic seq is allocated server-side,
 * and message lifecycle lives directly on `messages_in.status`.
 */
import Database from 'better-sqlite3';

import { insertRecord, upsertRecord, findRecord, findRecords, deleteRecords, pickRecord } from './records.js';

import { DATABASE_SCHEMA_VERSION, initializeSessionSchema } from './initialize.js';

/**
 * Journal mode for the session DB.
 *
 * The host is the sole opener but uses open-close-per-op (Session API per
 * request, delivery per drain, sweep per tick) rather than one cached handle.
 * DELETE (the SQLite default) fully persists on every close, so a subsequent
 * connection — including a read-only one — always sees committed data. WAL
 * would leave a `-wal` sidecar between opens, and a read-only reopen that
 * can't write the `-shm` can read stale/committed-but-uncheckpointed state.
 * Cross-process contention is bounded by busy_timeout; there is no cross-mount
 * access, so DELETE's coarser locking is fine.
 */
const JOURNAL_MODE = 'DELETE';
const BUSY_TIMEOUT_MS = 5000;

/** Create a new session at the public baseline, or verify its current schema. */
export function ensureSchema(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma(`journal_mode = ${JOURNAL_MODE}`);
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    initializeSessionSchema(db);
  } finally {
    db.close();
  }
}

/** Open the session DB (host is the sole opener). */
export function openSessionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { fileMustExist: true });
  if (db.pragma('user_version', { simple: true }) !== DATABASE_SCHEMA_VERSION) {
    db.close();
    throw new Error('Unsupported Luna session database version.');
  }
  db.pragma(`journal_mode = ${JOURNAL_MODE}`);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// seq allocation (single monotonic space across messages_in + messages_out)
// ---------------------------------------------------------------------------

/**
 * Next monotonic seq, shared across inbound and outbound. seq is the stable,
 * agent-facing message id returned by send_message and accepted by
 * edit_message / add_reaction, so it must be unique across both tables.
 */
export function nextSeq(db: Database.Database): number {
  const maxIn = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const maxOut = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  return Math.max(maxIn, maxOut) + 1;
}

// ---------------------------------------------------------------------------
// session_routing + destinations
// ---------------------------------------------------------------------------

export function upsertSessionRouting(
  db: Database.Database,
  routing: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
): void {
  upsertRecord(db, 'session_routing', { id: 1, ...routing }, ['id']);
}

export interface SessionRoutingRow {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRoutingRow(db: Database.Database): SessionRoutingRow {
  const row = findRecord<SessionRoutingRow & { id: number }>(db, 'session_routing', { id: 1 });
  return row
    ? (pickRecord(row, ['channel_type', 'platform_id', 'thread_id']) as unknown as SessionRoutingRow)
    : { channel_type: null, platform_id: null, thread_id: null };
}

export interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export function replaceDestinations(db: Database.Database, entries: DestinationRow[]): void {
  db.transaction(() => {
    db.exec('DELETE FROM destinations');
    for (const entry of entries) insertRecord(db, 'destinations', { ...entry });
  })();
}

export function getDestinationRows(db: Database.Database): DestinationRow[] {
  return findRecords<DestinationRow>(db, 'destinations', {}, { column: 'name' });
}

// ---------------------------------------------------------------------------
// messages_in
// ---------------------------------------------------------------------------

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id?: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export function insertMessage(
  db: Database.Database,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    /** 1 = wake the agent (default); 0 = accumulate as context only. */
    trigger?: 0 | 1;
    /** For agent-to-agent inbound: the source session id (return path). */
    sourceSessionId?: string | null;
    /** 1 = only deliver on the container's first poll (fresh start). */
    onWake?: 0 | 1;
  },
): void {
  db.transaction(() =>
    insertRecord(db, 'messages_in', {
      id: message.id,
      seq: nextSeq(db),
      kind: message.kind,
      content: message.content,
      timestamp: message.timestamp,
      status: 'pending',
      status_changed: nowIso(),
      series_id: message.id,
      trigger: message.trigger ?? 1,
      on_wake: message.onWake ?? 0,
      source_session_id: message.sourceSessionId ?? null,
      platform_id: message.platformId,
      channel_type: message.channelType,
      thread_id: message.threadId,
      process_after: message.processAfter,
      recurrence: message.recurrence,
    }),
  )();
}

export function countDueMessages(db: Database.Database): number {
  const result = db
    .prepare(
      `SELECT COUNT(id) AS total FROM messages_in
    WHERE trigger = 1 AND status = ? AND datetime(COALESCE(process_after, datetime('now'))) <= datetime('now')`,
    )
    .get('pending') as { total: number };
  return result.total;
}

/**
 * Pending messages due for processing, returned oldest-first for the agent.
 * Mirrors the old container-side query: the most recent `limit` pending rows
 * (any trigger — accumulated context rides along), on_wake-gated on cold start.
 */
export function getPendingForContainer(db: Database.Database, isFirstPoll: boolean, limit: number): MessageInRow[] {
  const rows = db
    .prepare(
      `SELECT id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger, platform_id, channel_type, thread_id, content
         FROM messages_in
        WHERE status = 'pending' AND kind != 'memory_edit'
          AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
          AND (on_wake = 0 OR @isFirstPoll = 1)
        ORDER BY seq DESC
        LIMIT @limit`,
    )
    .all({ isFirstPoll: isFirstPoll ? 1 : 0, limit }) as MessageInRow[];
  return rows.reverse();
}

export function markProcessing(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare("UPDATE messages_in SET status = 'processing', status_changed = ? WHERE id = ?");
  const now = nowIso();
  db.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  })();
}

export function markCompleted(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    "UPDATE messages_in SET status = 'completed', status_changed = ? WHERE id = ? AND status != 'completed'",
  );
  const now = nowIso();
  db.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  })();
}

export function markMessageFailed(db: Database.Database, messageId: string): void {
  db.prepare("UPDATE messages_in SET status = 'failed', status_changed = ? WHERE id = ?").run(nowIso(), messageId);
}

/** Reset a stuck message back to pending with backoff + tries++. */
export function retryWithBackoff(db: Database.Database, messageId: string, backoffSec: number): void {
  db.prepare(
    `UPDATE messages_in
        SET status = 'pending',
            status_changed = ?,
            tries = tries + 1,
            process_after = datetime('now', '+${backoffSec} seconds')
      WHERE id = ?`,
  ).run(nowIso(), messageId);
}

export function getMessageForRetry(
  db: Database.Database,
  messageId: string,
): { id: string; tries: number; processAfter: string | null; status: string } | undefined {
  return db
    .prepare('SELECT id, tries, process_after as processAfter, status FROM messages_in WHERE id = ?')
    .get(messageId) as { id: string; tries: number; processAfter: string | null; status: string } | undefined;
}

export interface ProcessingClaim {
  message_id: string;
  status_changed: string;
}

/** Messages currently claimed as 'processing', with their claim timestamps. */
export function getProcessingClaims(db: Database.Database): ProcessingClaim[] {
  return db
    .prepare(
      "SELECT id AS message_id, status_changed FROM messages_in WHERE status = 'processing' AND status_changed IS NOT NULL",
    )
    .all() as ProcessingClaim[];
}

/** Ids currently in 'processing' (used by the CLI turn-complete gate). */
export function getProcessingIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM messages_in WHERE status = 'processing'").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );
}

/** Mark every `processing` row completed (e.g. `/kill` cancelled the turn). */
export function completeAllProcessing(db: Database.Database): string[] {
  const ids = getProcessingIds(db);
  markCompleted(db, ids);
  return ids;
}

export function findQuestionResponse(db: Database.Database, questionId: string): MessageInRow | undefined {
  return db
    .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;
}

export function findCliResponse(db: Database.Database, requestId: string): { id: string; content: string } | null {
  const row = db
    .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"requestId":"${requestId}"%`) as { id: string; content: string } | undefined;
  return row ?? null;
}

export function resolveDestinationThread(
  db: Database.Database,
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  const row = db
    .prepare(
      `SELECT thread_id, id FROM messages_in
        WHERE channel_type = ? AND platform_id = ?
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
  return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
}

export interface TaskListRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

export function listTasks(db: Database.Database, status?: string | null): TaskListRow[] {
  // One row per series — the live (pending or paused) occurrence. Recurring
  // tasks accumulate one completed row per firing plus one live follow-up;
  // the series_id is the stable handle. When MAX(seq) appears in the SELECT
  // list of a GROUP BY query, the bare columns take values from the row that
  // contains that max — picking "the latest live row per series" in one pass.
  if (status) {
    return db
      .prepare(
        `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
           FROM messages_in
          WHERE kind = 'task' AND status = ?
          GROUP BY series_id
          ORDER BY process_after ASC`,
      )
      .all(status) as TaskListRow[];
  }
  return db
    .prepare(
      `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
         FROM messages_in
        WHERE kind = 'task' AND status IN ('pending', 'paused')
        GROUP BY series_id
        ORDER BY process_after ASC`,
    )
    .all() as TaskListRow[];
}

// ---------------------------------------------------------------------------
// messages_out
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  in_reply_to: string | null;
}

export interface WriteOutbound {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/** Insert an outbound message, allocating the single monotonic seq. Returns seq. */
export function insertOutboundMessage(db: Database.Database, msg: WriteOutbound): number {
  return db.transaction(() => {
    const existing = findRecord<{ seq: number }>(db, 'messages_out', { id: msg.id });
    if (existing) return existing.seq;
    const seq = nextSeq(db);
    insertRecord(db, 'messages_out', {
      id: msg.id,
      seq,
      kind: msg.kind,
      content: msg.content,
      timestamp: nowIso().slice(0, 19).replace('T', ' '),
      platform_id: msg.platform_id ?? null,
      channel_type: msg.channel_type ?? null,
      thread_id: msg.thread_id ?? null,
      in_reply_to: msg.in_reply_to ?? null,
      deliver_after: msg.deliver_after ?? null,
      recurrence: msg.recurrence ?? null,
    });
    return seq;
  })();
}

/**
 * Outbound rows that are due and not yet resolved (neither delivered nor
 * permanently failed), oldest first, capped at `limit`.
 *
 * The `NOT EXISTS` join replaces what used to be two unbounded scans per drain
 * — every row of `messages_out` plus the whole `delivered` table materialized
 * into a JS Set — filtered in JS afterwards. Since delivery fires eagerly on
 * every outbound write, that cost grew with total session history on every
 * single write. Callers drain again when a full batch comes back.
 */
export function getUndeliveredOutboundMessages(db: Database.Database, limit: number): OutboundMessage[] {
  return db
    .prepare(
      `SELECT m.* FROM messages_out m
        WHERE (m.deliver_after IS NULL OR m.deliver_after <= datetime('now'))
          AND m.kind != 'status'
          AND NOT EXISTS (SELECT 1 FROM delivered d WHERE d.message_out_id = m.id)
        ORDER BY m.timestamp ASC, m.seq ASC
        LIMIT @limit`,
    )
    .all({ limit }) as OutboundMessage[];
}

/**
 * Look up a message's platform id by seq. For inbound rows the id is already
 * the platform message id; for outbound rows resolve from `delivered`,
 * falling back to the internal id (edits on undelivered messages won't work).
 */
export function getMessageIdBySeq(db: Database.Database, seq: number): string | null {
  const inRow = db.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (inRow) return inRow.id;

  const outRow = db.prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (!outRow) return null;

  const deliveredRow = db
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  return outRow.id;
}

export function getRoutingBySeq(
  db: Database.Database,
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inRow = db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?').get(seq) as
    { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;
  const outRow = db.prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?').get(seq) as
    { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

// ---------------------------------------------------------------------------
// session_state
// ---------------------------------------------------------------------------

export function getSessionState(db: Database.Database, key: string): string | null {
  return findRecord<{ value: string }>(db, 'session_state', { key })?.value ?? null;
}

export function setSessionState(db: Database.Database, key: string, value: string): void {
  upsertRecord(db, 'session_state', { key, value, updated_at: nowIso() }, ['key']);
}

export function deleteSessionState(db: Database.Database, key: string): void {
  deleteRecords(db, 'session_state', { key });
}

// ---------------------------------------------------------------------------
// delivered
// ---------------------------------------------------------------------------

/** Terminal delivery state of one outbound row, or undefined if still queued. */
export type DeliveryStatus = 'delivered' | 'failed' | 'dismissed';

export function getDeliveryStatus(db: Database.Database, messageOutId: string): DeliveryStatus | undefined {
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(messageOutId) as
    { status: DeliveryStatus } | undefined;
  return row?.status;
}

export function markDelivered(db: Database.Database, messageOutId: string, platformMessageId: string | null): void {
  insertRecord(
    db,
    'delivered',
    {
      message_out_id: messageOutId,
      platform_message_id: platformMessageId,
      status: 'delivered',
      delivered_at: nowIso().slice(0, 19).replace('T', ' '),
    },
    true,
  );
}
export function markDeliveryFailed(db: Database.Database, messageOutId: string): void {
  insertRecord(
    db,
    'delivered',
    { message_out_id: messageOutId, platform_message_id: null, status: 'failed', delivered_at: nowIso() },
    true,
  );
}

/** A dismissal acknowledges a reviewed failure; it never claims delivery or queues a retry. */
export function dismissFailedDelivery(db: Database.Database, messageOutId: string, reason: string): boolean {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('A dismissal reason is required');
  const result = db
    .prepare(
      `UPDATE delivered SET status = 'dismissed', resolved_at = ?, resolution_reason = ?
       WHERE message_out_id = ? AND status = 'failed'`,
    )
    .run(nowIso(), trimmed, messageOutId);
  if (result.changes > 0) return true;
  if (getDeliveryStatus(db, messageOutId) === 'dismissed') return false;
  throw new Error('Only a terminal failed delivery can be dismissed');
}

/**
 * Count one failed delivery attempt and return the running total.
 *
 * Persisted rather than tracked in a process-local Map: the attempt budget is
 * what stops a doomed message from being retried forever, and an in-memory
 * counter resets on every host restart — so a message that can never be
 * delivered was retried indefinitely across restarts, three attempts at a time.
 */
export function recordDeliveryAttempt(db: Database.Database, messageOutId: string): number {
  const row = db
    .prepare(
      `UPDATE messages_out SET delivery_attempts = delivery_attempts + 1
        WHERE id = ?
        RETURNING delivery_attempts`,
    )
    .get(messageOutId) as { delivery_attempts: number } | undefined;
  return row?.delivery_attempts ?? 0;
}

/** Outbound rows abandoned after exhausting their delivery attempts. */
export function countFailedDeliveries(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM delivered WHERE status = 'failed'").get() as { n: number }).n;
}

/**
 * Look up quote text for a platform message id (e.g. Telegram `chatId:messageId`).
 *
 * Tries outbound first (agent messages via `delivered.platform_message_id`), then
 * inbound (`messages_in.id`, including the `:agentGroupId` namespace suffix).
 * Returns null when nothing matches or the stored content has no usable text.
 */
export function lookupQuotedMessageByPlatformId(
  db: Database.Database,
  platformMessageId: string,
): { text: string; sender?: string } | null {
  if (!platformMessageId) return null;

  const outRow = db
    .prepare(
      `SELECT mo.content AS content
         FROM delivered d
         JOIN messages_out mo ON mo.id = d.message_out_id
        WHERE d.platform_message_id = ?
        LIMIT 1`,
    )
    .get(platformMessageId) as { content: string } | undefined;
  if (outRow) {
    const parsed = parseStoredMessageText(outRow.content);
    if (parsed?.text) return parsed;
  }

  const inRow = db
    .prepare(
      `SELECT content FROM messages_in
        WHERE id = ? OR id LIKE ? || ':%'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(platformMessageId, platformMessageId) as { content: string } | undefined;
  if (inRow) {
    const parsed = parseStoredMessageText(inRow.content, { preferSender: true });
    if (parsed?.text) return parsed;
  }

  return null;
}

function parseStoredMessageText(
  content: string,
  opts?: { preferSender?: boolean },
): { text: string; sender?: string } | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const text =
      (typeof parsed.text === 'string' && parsed.text) ||
      (typeof parsed.markdown === 'string' && parsed.markdown) ||
      '';
    if (!text) return null;
    if (!opts?.preferSender) return { text };
    let sender: string | undefined;
    if (typeof parsed.sender === 'string' && parsed.sender) {
      sender = parsed.sender;
    } else if (typeof parsed.senderName === 'string' && parsed.senderName) {
      sender = parsed.senderName;
    } else if (parsed.author && typeof parsed.author === 'object') {
      const fullName = (parsed.author as { fullName?: unknown }).fullName;
      if (typeof fullName === 'string' && fullName) sender = fullName;
    }
    return sender ? { text, sender } : { text };
  } catch {
    return content.trim() ? { text: content } : null;
  }
}

/**
 * Timestamp (epoch ms) of an inbound message by id, or null. Used by the
 * ProgressController to resolve T0 from the `in_reply_to` of a status row.
 */
export function getInboundTimestampMs(db: Database.Database, messageId: string): number | null {
  const row = db.prepare('SELECT kind, timestamp, status_changed FROM messages_in WHERE id = ?').get(messageId) as
    { kind: string; timestamp: string; status_changed: string | null } | undefined;
  if (!row) return null;

  // A recurring occurrence is inserted when the previous run completes, so
  // its `timestamp` may be a day (or a week) older than the moment it actually
  // starts. markProcessing stamps status_changed immediately before the first
  // status event, which is the task's real T0. Chat timestamps remain the
  // user's send time so perceived latency still includes queue/wake delay.
  const source = row.kind === 'task' && row.status_changed ? row.status_changed : row.timestamp;
  const ms = Date.parse(source);
  return isNaN(ms) ? null : ms;
}

/** An inbound row's source_session_id by message id (a2a return path). */
export function getInboundSourceSessionId(db: Database.Database, messageId: string): string | null {
  const row = db.prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(messageId) as
    { source_session_id: string | null } | undefined;
  return row?.source_session_id ?? null;
}

/**
 * source_session_id of the most recent a2a inbound row from a specific peer.
 * Peer-affinity fallback in a2a routing when an outbound reply has no
 * `in_reply_to`.
 */
export function getMostRecentPeerSourceSessionId(db: Database.Database, peerAgentGroupId: string): string | null {
  const row = db
    .prepare(
      `SELECT source_session_id FROM messages_in
        WHERE channel_type = 'agent'
          AND platform_id = ?
          AND source_session_id IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(peerAgentGroupId) as { source_session_id: string | null } | undefined;
  return row?.source_session_id ?? null;
}
