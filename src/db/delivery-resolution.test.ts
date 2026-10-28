import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countFailedDeliveries,
  dismissFailedDelivery,
  ensureSchema,
  getDeliveryStatus,
  getUndeliveredOutboundMessages,
  insertOutboundMessage,
  markDelivered,
  markDeliveryFailed,
  openSessionDb,
  recordDeliveryAttempt,
} from './session-db.js';

let dir: string;
let dbPath: string;
let db: ReturnType<typeof openSessionDb>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-delivery-resolution-'));
  dbPath = path.join(dir, 'session.db');
  ensureSchema(dbPath);
  db = openSessionDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(id: string): void {
  insertOutboundMessage(db, {
    id,
    kind: 'chat',
    channel_type: 'cli',
    platform_id: 'local',
    content: JSON.stringify({ text: 'Memory digest completed.' }),
  });
}

describe('operator dismissal of terminal delivery failures', () => {
  it('preserves message bytes, attempts and failure time without making it deliverable', () => {
    seed('obsolete-notice');
    seed('unresolved-reply');
    seed('queued-reply');
    for (let n = 0; n < 3; n++) recordDeliveryAttempt(db, 'obsolete-notice');
    markDeliveryFailed(db, 'obsolete-notice');
    markDeliveryFailed(db, 'unresolved-reply');
    const before = db.prepare("SELECT * FROM messages_out WHERE id = 'obsolete-notice'").get();
    const failure = db.prepare("SELECT delivered_at FROM delivered WHERE message_out_id = 'obsolete-notice'").get();

    expect(dismissFailedDelivery(db, 'obsolete-notice', 'Reviewed obsolete digest notice')).toBe(true);
    expect(getDeliveryStatus(db, 'obsolete-notice')).toBe('dismissed');
    expect(countFailedDeliveries(db)).toBe(1);
    expect(db.prepare("SELECT * FROM messages_out WHERE id = 'obsolete-notice'").get()).toEqual(before);
    expect(db.prepare("SELECT * FROM delivered WHERE message_out_id = 'obsolete-notice'").get()).toMatchObject({
      ...failure!,
      platform_message_id: null,
      status: 'dismissed',
      resolved_at: expect.any(String),
      resolution_reason: 'Reviewed obsolete digest notice',
    });
    expect(getUndeliveredOutboundMessages(db, 10).map((m) => m.id)).toEqual(['queued-reply']);
  });

  it('replays a dismissal without replacing its original audit record', () => {
    seed('notice');
    markDeliveryFailed(db, 'notice');
    dismissFailedDelivery(db, 'notice', 'Original operator reason');
    const original = db.prepare('SELECT * FROM delivered').get();
    expect(dismissFailedDelivery(db, 'notice', 'Retry reason')).toBe(false);
    expect(db.prepare('SELECT * FROM delivered').get()).toEqual(original);
    markDelivered(db, 'notice', 'platform-id');
    expect(getDeliveryStatus(db, 'notice')).toBe('dismissed');
  });

  it('refuses queued, delivered, nonexistent messages and empty reasons', () => {
    seed('queued');
    seed('delivered');
    markDelivered(db, 'delivered', 'platform-id');
    for (const id of ['queued', 'delivered', 'missing']) {
      expect(() => dismissFailedDelivery(db, id, 'Reviewed')).toThrow('Only a terminal failed delivery');
    }
    expect(() => dismissFailedDelivery(db, 'queued', '  ')).toThrow('reason is required');
    expect(getUndeliveredOutboundMessages(db, 10).map((m) => m.id)).toEqual(['queued']);
  });

  it('rejects an incomplete session schema without rewriting its failure history', () => {
    seed('retained-notice');
    db.exec(`DROP TABLE delivered;
      CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, platform_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'delivered', delivered_at TEXT NOT NULL);`);
    markDeliveryFailed(db, 'retained-notice');
    const original = db.prepare('SELECT * FROM delivered').get();
    db.close();
    expect(() => ensureSchema(dbPath)).toThrow('Database columns do not match');
    db = openSessionDb(dbPath);
    expect(db.prepare('SELECT * FROM delivered').get()).toEqual(original);
    expect(countFailedDeliveries(db)).toBe(1);
  });
});
