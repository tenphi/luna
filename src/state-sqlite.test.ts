import type { QueueEntry } from 'chat';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, initTestDb } from './db/connection.js';
import { initializeCentralSchema } from './db/initialize.js';
import { SqliteStateAdapter } from './state-sqlite.js';
let state: SqliteStateAdapter;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
  initializeCentralSchema(initTestDb());
  state = new SqliteStateAdapter();
  await state.connect();
});
afterEach(() => {
  closeDb();
  vi.useRealTimers();
});
it('expires values at their deadline and permits a new conditional assignment', async () => {
  expect(await state.setIfNotExists('fixture', { value: 1 }, 50)).toBe(true);
  expect(await state.setIfNotExists('fixture', { value: 2 })).toBe(false);
  expect(await state.get('fixture')).toEqual({ value: 1 });
  vi.advanceTimersByTime(50);
  expect(await state.get('fixture')).toBeNull();
  expect(await state.setIfNotExists('fixture', { value: 3 })).toBe(true);
  await state.delete('fixture');
  expect(await state.get('fixture')).toBeNull();
});
it('requires the current lock token and rejects extension after expiration', async () => {
  const first = (await state.acquireLock('thread', 100))!;
  expect(await state.acquireLock('thread', 100)).toBeNull();
  expect(await state.extendLock({ ...first, token: 'wrong' }, 100)).toBe(false);
  vi.advanceTimersByTime(100);
  expect(await state.extendLock(first, 100)).toBe(false);
  const replacement = (await state.acquireLock('thread', 100))!;
  await state.releaseLock(first);
  expect(await state.acquireLock('thread', 100)).toBeNull();
  expect(await state.extendLock(replacement, 200)).toBe(true);
  await state.forceReleaseLock('thread');
  expect(await state.acquireLock('thread', 100)).not.toBeNull();
});
it('keeps subscriptions idempotent and lists bounded and chronological', async () => {
  await state.subscribe('thread');
  await state.subscribe('thread');
  expect(await state.isSubscribed('thread')).toBe(true);
  await state.unsubscribe('thread');
  expect(await state.isSubscribed('thread')).toBe(false);
  for (const value of [1, 2, 3]) await state.appendToList('list', value, { maxLength: 2, ttlMs: 100 });
  expect(await state.getList('list')).toEqual([2, 3]);
  vi.advanceTimersByTime(100);
  expect(await state.getList('list')).toEqual([]);
});
it('dequeues exactly once in FIFO order while enforcing capacity', async () => {
  const entries = [1, 2, 3].map((fixture) => ({ fixture }) as unknown as QueueEntry);
  for (const entry of entries) await state.enqueue('thread', entry, 2);
  expect(await state.queueDepth('thread')).toBe(2);
  expect(await state.dequeue('thread')).toEqual(entries[1]);
  expect(await state.dequeue('thread')).toEqual(entries[2]);
  expect(await state.dequeue('thread')).toBeNull();
  expect(await state.queueDepth('thread')).toBe(0);
});
