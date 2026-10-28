import type Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../config.js', () => ({ TIMEZONE: 'Europe/Paris' }));
import { ensureSchema, openSessionDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';
let directory: string;
let database: Database.Database;
const session = { id: 'synthetic-session' } as Session;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-series-contract-'));
  const filename = path.join(directory, 'session.db');
  ensureSchema(filename);
  database = openSessionDb(filename);
  insertTask(database, {
    id: 'task-series',
    recurrence: '0 9 * * *',
    processAfter: '2020-01-01T00:00:00Z',
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{"prompt":"Synthetic digest"}',
  });
  database.prepare("UPDATE messages_in SET status='completed'").run();
});
afterEach(() => {
  database.close();
  fs.rmSync(directory, { recursive: true });
});
it('creates one future local-time occurrence and does not repeat it on another sweep', async () => {
  await handleRecurrence(database, session);
  await handleRecurrence(database, session);
  const items = database
    .prepare('SELECT status, recurrence, series_id, process_after FROM messages_in ORDER BY seq')
    .all() as { status: string; recurrence: string | null; series_id: string; process_after: string }[];
  expect(items).toHaveLength(2);
  expect(items[0].recurrence).toBeNull();
  expect(items[1]).toMatchObject({ status: 'pending', recurrence: '0 9 * * *', series_id: 'task-series' });
  expect(new Date(items[1].process_after).getTime()).toBeGreaterThan(Date.now());
  expect(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit' }).format(
      new Date(items[1].process_after),
    ),
  ).toBe('09');
});
it('retains the original recurrence if insertion fails so a later sweep can retry', async () => {
  database.exec(
    "CREATE TRIGGER reject_fixture BEFORE INSERT ON messages_in BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  await handleRecurrence(database, session);
  expect(database.prepare('SELECT recurrence FROM messages_in').get()).toEqual({ recurrence: '0 9 * * *' });
  database.exec('DROP TRIGGER reject_fixture');
  await handleRecurrence(database, session);
  expect(database.prepare('SELECT count(*) AS total FROM messages_in').get()).toEqual({ total: 2 });
});
