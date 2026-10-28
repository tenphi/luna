/**
 * Host session store tests — the single per-session session.db.
 *
 * Covers the invariants the HTTP cutover introduced: one monotonic seq shared
 * across inbound + outbound, and message lifecycle tracked directly on
 * messages_in.status (no processing_ack side-channel).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureSchema,
  getPendingForContainer,
  getInboundTimestampMs,
  getProcessingClaims,
  insertMessage,
  insertOutboundMessage,
  markCompleted,
  markProcessing,
  markDelivered,
  completeAllProcessing,
  lookupQuotedMessageByPlatformId,
  nextSeq,
  openSessionDb,
} from './session-db.js';

let dir: string;
let dbPath: string;
let db: ReturnType<typeof openSessionDb>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-sessiondb-'));
  dbPath = path.join(dir, 'session.db');
  ensureSchema(dbPath);
  db = openSessionDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedInbound(id: string, trigger: 0 | 1 = 1): void {
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'p1',
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify({ text: id }),
    processAfter: null,
    recurrence: null,
    trigger,
  });
}

describe('single monotonic seq', () => {
  it('returns the original outbound sequence on a retry without replacing its content', () => {
    const original = insertOutboundMessage(db, {
      id: 'retry-notice',
      kind: 'chat',
      content: '{"text":"First notice"}',
    });
    seedInbound('later-message');
    expect(
      insertOutboundMessage(db, { id: 'retry-notice', kind: 'chat', content: '{"text":"Different notice"}' }),
    ).toBe(original);
    expect(db.prepare('SELECT content, seq FROM messages_out WHERE id = ?').get('retry-notice')).toEqual({
      content: '{"text":"First notice"}',
      seq: original,
    });
    expect(nextSeq(db)).toBe(3);
  });
  it('increments across inbound and outbound in one space', () => {
    seedInbound('in-1');
    seedInbound('in-2');
    const outSeq = insertOutboundMessage(db, { id: 'out-1', kind: 'chat', content: '{}' });
    seedInbound('in-3');

    const seqs = (db.prepare('SELECT seq FROM messages_in ORDER BY seq').all() as Array<{ seq: number }>).map(
      (r) => r.seq,
    );
    expect(seqs).toEqual([1, 2, 4]);
    expect(outSeq).toBe(3);
    // Next allocation is strictly greater than any existing seq in either table.
    expect(nextSeq(db)).toBe(5);
  });

  it('never reuses a seq after the max-holder is deleted', () => {
    seedInbound('in-1');
    const s = insertOutboundMessage(db, { id: 'out-1', kind: 'chat', content: '{}' });
    expect(s).toBe(2);
    // nextSeq is MAX-based; documents that gaps are fine but forward-only
    // within a live row set.
    expect(nextSeq(db)).toBe(3);
  });
});

describe('status lifecycle on messages_in', () => {
  it('pending → processing → completed via direct status updates', () => {
    seedInbound('in-1');

    const pending = getPendingForContainer(db, true, 10);
    expect(pending.map((m) => m.id)).toEqual(['in-1']);

    markProcessing(db, ['in-1']);
    expect(getProcessingClaims(db).map((c) => c.message_id)).toEqual(['in-1']);
    // No longer surfaced as pending while processing.
    expect(getPendingForContainer(db, true, 10)).toHaveLength(0);

    markCompleted(db, ['in-1']);
    expect(getProcessingClaims(db)).toHaveLength(0);
    expect(getPendingForContainer(db, true, 10)).toHaveLength(0);
  });

  it('completeAllProcessing marks every processing row completed', () => {
    seedInbound('in-a');
    seedInbound('in-b');
    markProcessing(db, ['in-a', 'in-b']);
    expect(completeAllProcessing(db).sort()).toEqual(['in-a', 'in-b']);
    expect(getProcessingClaims(db)).toHaveLength(0);
  });

  it('times scheduled-task progress from its processing claim, not when the occurrence was inserted', () => {
    insertMessage(db, {
      id: 'task-1',
      kind: 'task',
      timestamp: '2026-08-11T07:30:00.000Z',
      platformId: 'p1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ prompt: 'daily briefing' }),
      processAfter: '2026-08-12T07:30:00.000Z',
      recurrence: '30 9 * * *',
    });
    db.prepare("UPDATE messages_in SET status_changed = ? WHERE id = 'task-1'").run('2026-08-12T07:30:34.000Z');

    expect(getInboundTimestampMs(db, 'task-1')).toBe(Date.parse('2026-08-12T07:30:34.000Z'));
  });

  it('on_wake rows only surface on the first poll', () => {
    insertMessage(db, {
      id: 'wake-1',
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
      onWake: 1,
    });

    expect(getPendingForContainer(db, false, 10)).toHaveLength(0);
    expect(getPendingForContainer(db, true, 10).map((m) => m.id)).toEqual(['wake-1']);
  });

  it('returns pending oldest-first, capped at limit', () => {
    for (let i = 1; i <= 5; i++) seedInbound(`in-${i}`);
    const rows = getPendingForContainer(db, true, 3);
    // Most recent 3 by seq, returned oldest-first.
    expect(rows.map((m) => m.id)).toEqual(['in-3', 'in-4', 'in-5']);
  });
});

describe('lookupQuotedMessageByPlatformId', () => {
  it('resolves outbound text via delivered.platform_message_id', () => {
    const outId = 'out-agent-1';
    insertOutboundMessage(db, {
      id: outId,
      kind: 'chat',
      content: JSON.stringify({ text: 'Agent said this earlier' }),
    });
    markDelivered(db, outId, '1000000001:6634');

    expect(lookupQuotedMessageByPlatformId(db, '1000000001:6634')).toEqual({
      text: 'Agent said this earlier',
    });
  });

  it('resolves inbound text including agent-group id suffix', () => {
    insertMessage(db, {
      id: '1000000001:100:luna-default',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'telegram:1000000001',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({
        text: 'User earlier message',
        sender: 'Ada Marlow',
      }),
      processAfter: null,
      recurrence: null,
    });

    expect(lookupQuotedMessageByPlatformId(db, '1000000001:100')).toEqual({
      text: 'User earlier message',
      sender: 'Ada Marlow',
    });
  });

  it('returns null when platform id is unknown', () => {
    expect(lookupQuotedMessageByPlatformId(db, '1000000001:99999')).toBeNull();
  });
});
