import { randomUUID } from 'node:crypto';
import type { QueueEntry, StateAdapter } from 'chat';
import { getDb } from './db/connection.js';

type Lock = { token: string; threadId: string; expiresAt: number };
type Stored = { value: string; expires_at: number | null };
const expiry = (ttl?: number): number | null => (ttl ? Date.now() + ttl : null);

/** Durable Chat SDK state shares the host database without owning its lifecycle. */
export class SqliteStateAdapter implements StateAdapter {
  private purge(): void {
    const db = getDb();
    for (const table of ['chat_sdk_kv', 'chat_sdk_lists', 'chat_sdk_locks']) {
      db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(Date.now());
    }
  }

  async connect(): Promise<void> {
    this.purge();
  }
  async disconnect(): Promise<void> {}

  async get<T = unknown>(key: string): Promise<T | null> {
    this.purge();
    const item = getDb().prepare('SELECT value FROM chat_sdk_kv WHERE key=?').get(key) as Stored | undefined;
    return item ? (JSON.parse(item.value) as T) : null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    getDb()
      .prepare(
        `INSERT INTO chat_sdk_kv VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), expiry(ttlMs));
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return getDb().transaction(() => {
      this.purge();
      return (
        getDb()
          .prepare('INSERT INTO chat_sdk_kv VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
          .run(key, JSON.stringify(value), expiry(ttlMs)).changes === 1
      );
    })();
  }

  async delete(key: string): Promise<void> {
    getDb().prepare('DELETE FROM chat_sdk_kv WHERE key=?').run(key);
  }

  async subscribe(threadId: string): Promise<void> {
    getDb().prepare('INSERT INTO chat_sdk_subscriptions (thread_id) VALUES (?) ON CONFLICT DO NOTHING').run(threadId);
  }
  async unsubscribe(threadId: string): Promise<void> {
    getDb().prepare('DELETE FROM chat_sdk_subscriptions WHERE thread_id=?').run(threadId);
  }
  async isSubscribed(threadId: string): Promise<boolean> {
    return Boolean(getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions WHERE thread_id=?').get(threadId));
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const lock: Lock = { token: randomUUID(), expiresAt: Date.now() + ttlMs, threadId };
    const changed = getDb()
      .prepare(
        `INSERT INTO chat_sdk_locks VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
      WHERE chat_sdk_locks.expires_at <= ?`,
      )
      .run(threadId, lock.token, lock.expiresAt, Date.now()).changes;
    return changed ? lock : null;
  }
  async releaseLock(lock: Lock): Promise<void> {
    getDb().prepare('DELETE FROM chat_sdk_locks WHERE token=? AND thread_id=?').run(lock.token, lock.threadId);
  }
  async forceReleaseLock(threadId: string): Promise<void> {
    getDb().prepare('DELETE FROM chat_sdk_locks WHERE thread_id=?').run(threadId);
  }
  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const deadline = Date.now() + ttlMs;
    const changed = getDb()
      .prepare('UPDATE chat_sdk_locks SET expires_at=? WHERE token=? AND thread_id=? AND expires_at>?')
      .run(deadline, lock.token, lock.threadId, Date.now()).changes;
    if (changed) lock.expiresAt = deadline;
    return Boolean(changed);
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    getDb().transaction(() => {
      this.purge();
      getDb()
        .prepare(
          `INSERT INTO chat_sdk_lists (key, idx, value, expires_at)
        SELECT ?, COALESCE(MAX(idx)+1, 0), ?, ? FROM chat_sdk_lists WHERE key=?`,
        )
        .run(key, JSON.stringify(value), expiry(options?.ttlMs), key);
      if (options?.maxLength) {
        getDb()
          .prepare(
            `DELETE FROM chat_sdk_lists WHERE key=? AND idx NOT IN
          (SELECT idx FROM chat_sdk_lists WHERE key=? ORDER BY idx DESC LIMIT ?)`,
          )
          .run(key, key, options.maxLength);
      }
    })();
  }
  async getList<T = unknown>(key: string): Promise<T[]> {
    this.purge();
    const rows = getDb().prepare('SELECT value FROM chat_sdk_lists WHERE key=? ORDER BY idx').all(key) as Stored[];
    return rows.map(({ value }) => JSON.parse(value) as T);
  }
  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    await this.appendToList(`queue:${threadId}`, entry, { maxLength: maxSize });
    return this.queueDepth(threadId);
  }
  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return getDb().transaction(() => {
      this.purge();
      const first = getDb()
        .prepare(
          `DELETE FROM chat_sdk_lists WHERE rowid=(
        SELECT rowid FROM chat_sdk_lists WHERE key=? ORDER BY idx LIMIT 1) RETURNING value`,
        )
        .get(`queue:${threadId}`) as Stored | undefined;
      return first ? (JSON.parse(first.value) as QueueEntry) : null;
    })();
  }
  async queueDepth(threadId: string): Promise<number> {
    this.purge();
    return (
      getDb().prepare('SELECT COUNT(*) AS depth FROM chat_sdk_lists WHERE key=?').get(`queue:${threadId}`) as {
        depth: number;
      }
    ).depth;
  }
}
