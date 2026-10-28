import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSchema, openSessionDb } from '../../db/session-db.js';
import {
  cancelTask,
  clearRecurrence,
  getCompletedRecurring,
  insertRecurrence,
  insertTask,
  pauseTask,
  resumeTask,
  updateTask,
} from './db.js';
let directory: string;
let database: Database.Database;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-tasks-contract-'));
  const filename = path.join(directory, 'session.db');
  ensureSchema(filename);
  database = openSessionDb(filename);
});
afterEach(() => {
  database.close();
  fs.rmSync(directory, { recursive: true });
});
function create(id = 'task-original', recurrence: string | null = null): void {
  insertTask(database, {
    id,
    recurrence,
    processAfter: '2027-01-01T09:00:00Z',
    platformId: 'synthetic-chat',
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify({ prompt: 'Review synthetic notes', metadata: 'keep' }),
  });
}
const rows = () => database.prepare('SELECT * FROM messages_in ORDER BY seq').all() as Record<string, unknown>[];
it('inserts an idempotent pending task with a stable series identity', () => {
  create();
  create();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({
    id: 'task-original',
    kind: 'task',
    status: 'pending',
    series_id: 'task-original',
    platform_id: 'synthetic-chat',
    tries: 0,
  });
});
it('updates live series occurrences while preserving completed history and unrelated content', () => {
  create('task-original', '0 9 * * *');
  database.prepare("UPDATE messages_in SET status='completed'").run();
  insertRecurrence(database, getCompletedRecurring(database)[0], 'task-next', '2027-01-02T09:00:00Z');
  clearRecurrence(database, 'task-original');
  expect(updateTask(database, 'task-original', { prompt: 'New prompt', script: null })).toBe(1);
  expect(JSON.parse(rows()[1].content as string)).toEqual({ prompt: 'New prompt', metadata: 'keep', script: null });
  expect(JSON.parse(rows()[0].content as string).prompt).toBe('Review synthetic notes');
  expect(updateTask(database, 'missing', {})).toBe(0);
});
it('pauses, resumes, and cancels the live part of a recurring series', () => {
  create('task-original', '0 9 * * *');
  database.prepare("UPDATE messages_in SET status='completed'").run();
  insertRecurrence(database, getCompletedRecurring(database)[0], 'task-next', '2027-01-02T09:00:00Z');
  clearRecurrence(database, 'task-original');
  pauseTask(database, 'task-original');
  expect(rows()[1].status).toBe('paused');
  resumeTask(database, 'task-original');
  expect(rows()[1].status).toBe('pending');
  cancelTask(database, 'task-original');
  expect(rows()[1]).toMatchObject({ status: 'completed', recurrence: null });
  resumeTask(database, 'task-original');
  expect(rows()[1].status).toBe('completed');
});
it('rolls back a multi-row content edit if any row contains malformed JSON', () => {
  create();
  create('task-second');
  database.prepare("UPDATE messages_in SET series_id='series'").run();
  database.prepare("UPDATE messages_in SET content='invalid' WHERE id='task-second'").run();
  expect(() => updateTask(database, 'series', { prompt: 'Changed' })).toThrow();
  expect(JSON.parse(rows()[0].content as string).prompt).toBe('Review synthetic notes');
});
