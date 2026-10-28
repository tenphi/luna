import type Database from 'better-sqlite3';
import { insertRecord, updateRecords } from '../../db/records.js';
import { nextSeq } from '../../db/session-db.js';

type Task = {
  id: string;
  processAfter: string;
  recurrence: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
};
export type TaskUpdate = { prompt?: string; script?: string | null; recurrence?: string | null; processAfter?: string };
export type RecurringMessage = {
  id: string;
  kind: string;
  content: string;
  recurrence: string;
  process_after: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  series_id: string;
};

function add(db: Database.Database, row: Record<string, unknown>, ignore = false): void {
  insertRecord(
    db,
    'messages_in',
    { timestamp: new Date().toISOString(), seq: nextSeq(db), status: 'pending', ...row },
    ignore,
  );
}

export function insertTask(db: Database.Database, task: Task): void {
  add(
    db,
    {
      id: task.id,
      kind: 'task',
      tries: 0,
      series_id: task.id,
      recurrence: task.recurrence,
      process_after: task.processAfter,
      content: task.content,
      platform_id: task.platformId,
      channel_type: task.channelType,
      thread_id: task.threadId,
    },
    true,
  );
}

function transition(db: Database.Database, id: string, from: string[], to: string, cancelled = false): void {
  updateRecords(
    db,
    'messages_in',
    { status: to, ...(cancelled ? { recurrence: null } : {}) },
    `kind='task' AND (series_id=? OR id=?) AND status IN (${from.map(() => '?').join(',')})`,
    [id, id, ...from],
  );
}
export const cancelTask = (db: Database.Database, id: string): void =>
  transition(db, id, ['pending', 'paused'], 'completed', true);
export const pauseTask = (db: Database.Database, id: string): void => transition(db, id, ['pending'], 'paused');
export const resumeTask = (db: Database.Database, id: string): void => transition(db, id, ['paused'], 'pending');

export function updateTask(db: Database.Database, id: string, change: TaskUpdate): number {
  return db.transaction(() => {
    const active = db
      .prepare(
        "SELECT id, content FROM messages_in WHERE kind='task' AND status IN ('paused','pending') AND (series_id=? OR id=?)",
      )
      .all(id, id) as { id: string; content: string }[];
    for (const row of active) {
      const fields: Record<string, unknown> = { process_after: change.processAfter, recurrence: change.recurrence };
      if (change.prompt !== undefined || change.script !== undefined) {
        const content: Record<string, unknown> = JSON.parse(row.content);
        for (const key of ['prompt', 'script'] as const) if (change[key] !== undefined) content[key] = change[key];
        fields.content = JSON.stringify(content);
      }
      updateRecords(db, 'messages_in', fields, 'id=?', [row.id]);
    }
    return active.length;
  })();
}

export const getCompletedRecurring = (db: Database.Database): RecurringMessage[] =>
  db
    .prepare("SELECT * FROM messages_in WHERE recurrence IS NOT NULL AND status='completed'")
    .all() as RecurringMessage[];
export function insertRecurrence(
  db: Database.Database,
  source: RecurringMessage,
  id: string,
  nextRun: string | null,
): void {
  add(db, {
    id,
    kind: source.kind,
    content: source.content,
    series_id: source.series_id,
    process_after: nextRun,
    recurrence: source.recurrence,
    platform_id: source.platform_id,
    channel_type: source.channel_type,
    thread_id: source.thread_id,
  });
}
export function clearRecurrence(db: Database.Database, id: string): void {
  updateRecords(db, 'messages_in', { recurrence: null }, 'id=?', [id]);
}
