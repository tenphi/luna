/**
 * Delivery race tests.
 *
 * Eager delivery (Session API writeMessageOut) and the 60s sweep both call
 * deliverSessionMessages. Concurrent callers on the same session must not
 * double-send; rows written while a drain is in flight must still be
 * delivered without waiting for the sweep.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', async () => {
  const { fakeContainers } = await import('../test/support/containers.js');
  return fakeContainers();
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-delivery' };
});

const TEST_DIR = '/tmp/luna-test-delivery';

import { initTestDb, closeDb, initializeCentralSchema, createAgentGroup, createMessagingGroup } from './db/index.js';
import { countFailedDeliveries, getDeliveryStatus, insertOutboundMessage } from './db/session-db.js';
import { resolveSession, sessionDbPath, openSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string, text = 'hello'): void {
  const database = openSession(agentGroupId, sessionId);
  try {
    insertOutboundMessage(database, {
      id: msgId,
      kind: 'chat',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      content: JSON.stringify({ text }),
    });
  } finally {
    database.close();
  }
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initializeCentralSchema(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('deliverSessionMessages — no silent drops', () => {
  it('delivers only report text while leaving the private source snapshot available for recovery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'sourced-report', 'A proposed review remains unconfirmed.');
    const db = openSession('ag-1', session.id);
    const content = {
      text: 'A proposed review remains unconfirmed.',
      memory_evidence: {
        emails: [{ text: 'Private source body', mentioned_at: '2031-04-02T18:30:00.000Z' }],
        omitted: 0,
      },
      source_email_ids: ['ada:111'],
    };
    db.prepare('UPDATE messages_out SET content = ? WHERE id = ?').run(JSON.stringify(content), 'sourced-report');
    db.close();
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, outgoing) {
        calls.push(outgoing);
        return 'plat-report';
      },
    });
    await deliverSessionMessages(session);
    expect(calls.map((outgoing) => JSON.parse(outgoing))).toEqual([{ text: content.text }]);
    const check = openSession('ag-1', session.id);
    expect(
      JSON.parse(
        (check.prepare('SELECT content FROM messages_out WHERE id = ?').get('sourced-report') as { content: string })
          .content,
      ),
    ).toEqual(content);
    check.close();
  });

  it('retries instead of marking delivered when no adapter is wired', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-no-adapter');

    setDeliveryAdapter(null as unknown as Parameters<typeof setDeliveryAdapter>[0]);
    await deliverSessionMessages(session);

    // Not resolved either way yet — still queued for the next attempt.
    let inDb = openSession('ag-1', session.id);
    expect(getDeliveryStatus(inDb, 'out-no-adapter')).toBeUndefined();
    inDb.close();

    // Once an adapter appears, the message goes out rather than being lost.
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        calls.push(content);
        return 'plat-late';
      },
    });
    await deliverSessionMessages(session);

    expect(calls).toHaveLength(1);
    inDb = openSession('ag-1', session.id);
    expect(getDeliveryStatus(inDb, 'out-no-adapter')).toBe('delivered');
    inDb.close();
  });

  it('records a message with no routing as failed, not delivered', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    const db = new Database(sessionDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-unrouted', datetime('now'), 'chat', NULL, NULL, ?)`,
    ).run(JSON.stringify({ text: 'nowhere' }));
    db.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        calls.push(content);
        return 'plat-x';
      },
    });

    // Exhaust MAX_DELIVERY_ATTEMPTS.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(calls).toHaveLength(0);
    const inDb = openSession('ag-1', session.id);
    expect(getDeliveryStatus(inDb, 'out-unrouted')).toBe('failed');
    inDb.close();
  });
});

describe('deliverSessionMessages — platform rate limits', () => {
  /** Shaped like the Chat SDK's AdapterRateLimitError (see channels/adapter-errors.ts). */
  function rateLimited(retryAfter?: number): Error {
    const err = new Error('Rate limited by telegram');
    err.name = 'AdapterRateLimitError';
    if (retryAfter !== undefined) (err as Error & { retryAfter?: number }).retryAfter = retryAfter;
    return err;
  }

  it('does not spend the attempt budget on a 429', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-429');

    let attempts = 0;
    setDeliveryAdapter({
      async deliver() {
        attempts++;
        // A busy chat can outlast MAX_DELIVERY_ATTEMPTS worth of sends.
        if (attempts <= 4) throw rateLimited(0);
        return 'plat-eventually';
      },
    });

    for (let i = 0; i < 5; i++) await deliverSessionMessages(session);

    const inDb = openSession('ag-1', session.id);
    // The message survived the rate limiting instead of being written off.
    expect(getDeliveryStatus(inDb, 'out-429')).toBe('delivered');
    inDb.close();
  });

  it('waits out the window the platform asked for', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-429-wait');

    let attempts = 0;
    setDeliveryAdapter({
      async deliver() {
        attempts++;
        throw rateLimited(60);
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // The second drain respected the 60s window rather than hammering.
    expect(attempts).toBe(1);
  });
});

describe('deliverSessionMessages — batching', () => {
  it('drains a backlog larger than one batch in a single call', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // DRAIN_BATCH_LIMIT is 200, so this needs more than one pass.
    const total = 205;
    for (let i = 0; i < total; i++) insertOutbound('ag-1', session.id, `out-bulk-${i}`);

    let calls = 0;
    setDeliveryAdapter({
      async deliver() {
        calls++;
        return `plat-${calls}`;
      },
    });

    await deliverSessionMessages(session);

    expect(calls).toBe(total);
  });

  it('reuses a caller-owned handle and leaves it open', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-shared-handle');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        calls.push(content);
        return 'plat-shared';
      },
    });

    // The host sweep already holds the handle for stuck-message recovery and
    // hands it down rather than reopening the file.
    const db = openSession('ag-1', session.id);
    await deliverSessionMessages(session, db);

    expect(calls).toHaveLength(1);
    // Still usable — delivery must not close a handle it did not open.
    expect(getDeliveryStatus(db, 'out-shared-handle')).toBe('delivered');
    db.close();
  });

  it('does not let a permanently failed message block the queue behind it', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-doomed');

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        const { text } = JSON.parse(content) as { text: string };
        if (text === 'hello') throw new Error('nope');
        sent.push(text);
        return 'plat-ok';
      },
    });

    // Exhaust MAX_DELIVERY_ATTEMPTS on the doomed row.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    const inDb = openSession('ag-1', session.id);
    expect(getDeliveryStatus(inDb, 'out-doomed')).toBe('failed');
    inDb.close();

    // A later message still gets through — the failed row is resolved in
    // `delivered`, so the undelivered query skips it.
    insertOutbound('ag-1', session.id, 'out-after', 'after');
    await deliverSessionMessages(session);
    expect(sent).toEqual(['after']);
  });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('serializes overlapping drains and completes one channel send', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'overlap-fixture');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async () => {
      await blocked;
      return 'accepted-fixture';
    });
    setDeliveryAdapter({ deliver });
    const draining = deliverSessionMessages(session);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);
    release();
    await draining;
    await deliverSessionMessages(session);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('re-drains rows written while an in-flight delivery held the lock', async () => {
    // Reproduces the Telegram bank-review stall: status edits hold the drain
    // open; phase:done + final chat arrive mid-flight; without pending
    // redelivery those rows waited for the 60s sweep.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first', 'first');

    const deliveredTexts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void;
    const sawFirst = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const text = JSON.parse(content).text as string;
        deliveredTexts.push(text);
        if (text === 'first') {
          firstStarted!();
          await firstHeld;
        }
        return `plat-${text}`;
      },
    });

    const firstDrain = deliverSessionMessages(session);
    await sawFirst;

    insertOutbound('ag-1', session.id, 'out-second', 'second');
    // Concurrent eager delivery — must not double-send out-first, but must
    // schedule a re-drain for out-second.
    const skipped = deliverSessionMessages(session);
    await skipped;

    releaseFirst!();
    await firstDrain;

    expect(deliveredTexts).toEqual(['first', 'second']);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const inDb = openSession('ag-1', session.id);
    const status = getDeliveryStatus(inDb, 'out-flaky');
    inDb.close();
    expect(status).toBe('failed');
  });

  it('keeps the attempt budget across a host restart', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-doomed-restart');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('permanently broken');
      },
    });

    // Two attempts, then the host restarts. The counter used to live in a
    // process-local Map, so a restart handed the message a fresh budget and a
    // message that could never be delivered was retried forever.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    const inDb = openSession('ag-1', session.id);
    const attempts = inDb
      .prepare('SELECT delivery_attempts AS a FROM messages_out WHERE id = ?')
      .get('out-doomed-restart') as { a: number };
    expect(attempts.a).toBe(2);
    inDb.close();

    // Third attempt exhausts the budget regardless of how many processes it took.
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    const after = openSession('ag-1', session.id);
    expect(getDeliveryStatus(after, 'out-doomed-restart')).toBe('failed');
    expect(countFailedDeliveries(after)).toBe(1);
    after.close();

    // And it stays given up on.
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);
  });

  it('clears attempt counter on successful delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'telegram',
      platform_id: 'telegram:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (telegram) — not the origin chat
    const outDb = new Database(sessionDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'telegram:456', 'telegram', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const inDb = openSession('ag-1', session.id);
    const status = getDeliveryStatus(inDb, 'out-unauth');
    inDb.close();
    expect(status).toBe('failed');
  });
});

it('does not spin when a full outbound batch is waiting for a rate limit', async () => {
  seedAgentAndChannel();
  const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
  const db = openSession('ag-1', session.id);
  const insert = db.prepare(`INSERT INTO messages_out (id, timestamp, kind, channel_type, platform_id, content)
    VALUES (?, datetime('now'), 'chat', 'telegram', 'telegram:123', '{"text":"Synthetic bounded batch"}')`);
  db.transaction(() => {
    for (let index = 0; index < 200; index++) insert.run(`backoff-batch-${index}`);
  })();
  db.close();
  const deliver = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('synthetic limit'), { name: 'AdapterRateLimitError', retryAfter: 120 }));
  setDeliveryAdapter({ deliver });
  await deliverSessionMessages(session);
  await deliverSessionMessages(session);
  expect(deliver).toHaveBeenCalledTimes(200);
});
