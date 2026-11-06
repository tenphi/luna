/**
 * Unit tests for the stuck-container decision logic and stale-claim reset.
 * `decideStuckAction` is pure; the reset path runs against a real session.db
 * (single file) since processing status now lives on messages_in.status.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureSchema,
  getProcessingClaims,
  getSessionRoutingRow,
  insertMessage,
  insertOutboundMessage,
  markProcessing,
  openSessionDb,
  upsertSessionRouting,
} from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  MAX_SILENT_WAKE_FAILURES,
  _noteWakeFailureForTesting,
  _resetStuckProcessingRowsForTesting,
  _resetWakeFailuresForTesting,
  decideStuckAction,
  parseSqliteUtc,
} from './host-sweep.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when last-seen is fresh and no claims', () => {
    expect(decideStuckAction({ now: BASE, lastSeenMs: BASE - 5_000, tool: null, claims: [] })).toEqual({
      action: 'ok',
    });
  });

  it('returns kill-ceiling when last-seen older than 30 min', () => {
    const lastSeenMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({ now: BASE, lastSeenMs, tool: null, claims: [] });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when never seen (fresh container not yet pinged)', () => {
    const res = decideStuckAction({ now: BASE, lastSeenMs: 0, tool: null, claims: [] });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when never seen AND a claim has aged past tolerance', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: 0,
      tool: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - 45 * 60 * 1000,
      tool: { tool: 'Bash', toolDeclaredTimeoutMs: twoHrMs },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and last-seen has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - claimedAgeMs - 5_000,
      tool: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when a ping landed since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - 2_000,
      tool: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - CLAIM_STUCK_MS - 10_000,
      tool: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - 5 * 60 * 1000 - 5_000,
      tool: { tool: 'Bash', toolDeclaredTimeoutMs: tenMinMs },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      lastSeenMs: BASE - 5_000,
      tool: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-claim reset. With the single DB the container's claim IS the
// messages_in.status='processing' row, so resetting it back to pending both
// reschedules the message and clears the claim in one write.
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let db: ReturnType<typeof openSessionDb>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-sweep-'));
  const dbPath = path.join(dir, 'session.db');
  ensureSchema(dbPath);
  db = openSessionDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function seed(id: string): void {
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: '{}',
    processAfter: null,
    recurrence: null,
  });
}

describe('resetStuckProcessingRows', () => {
  it('reschedules a stuck processing row with backoff and clears the claim', () => {
    seed('m-1');
    markProcessing(db, ['m-1']);
    expect(getProcessingClaims(db)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(db, fakeSession(), 'absolute-ceiling');

    // Claim gone — the row is pending again, so the next sweep tick sees no
    // 'processing' rows and won't kill a freshly respawned container.
    expect(getProcessingClaims(db)).toEqual([]);

    const row = db.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('leaves a row already rescheduled for the future untouched (skip path)', () => {
    seed('m-2');
    markProcessing(db, ['m-2']);
    const future = new Date(Date.now() + 60_000).toISOString();
    // Simulate a prior retry: pending, future process_after, tries=1, but the
    // claim (status) still reads processing until reset. Force the state.
    db.prepare("UPDATE messages_in SET process_after = ?, tries = 1 WHERE id = 'm-2'").run(future);

    _resetStuckProcessingRowsForTesting(db, fakeSession(), 'claim-stuck');

    const row = db.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped — the future process_after held
  });

  // The outcome is what the progress bubble is written from — "retrying in 5s"
  // vs. a bare interrupted state — so it has to describe the pass accurately.
  it('reports the soonest retry it scheduled', () => {
    seed('m-3');
    seed('m-4');
    markProcessing(db, ['m-3', 'm-4']);
    db.prepare("UPDATE messages_in SET tries = 3 WHERE id = 'm-4'").run();

    const outcome = _resetStuckProcessingRowsForTesting(db, fakeSession(), 'claim-stuck');

    expect(outcome).toEqual({ retried: 2, failed: 0, nextRetrySec: 5 });
  });

  it('reports a give-up with no retry to promise', () => {
    seed('m-5');
    markProcessing(db, ['m-5']);
    db.prepare("UPDATE messages_in SET tries = 5 WHERE id = 'm-5'").run();

    const outcome = _resetStuckProcessingRowsForTesting(db, fakeSession(), 'claim-stuck');

    expect(outcome).toEqual({ retried: 0, failed: 1, nextRetrySec: null });
  });

  it('reports nothing to do when no claims are stuck', () => {
    const outcome = _resetStuckProcessingRowsForTesting(db, fakeSession(), 'container not running');
    expect(outcome).toEqual({ retried: 0, failed: 0, nextRetrySec: null });
  });
});

describe('parseSqliteUtc', () => {
  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failed-wake notice. A wake failure leaves the triggering message pending with
// nothing running to read it; the sweep retries forever, which used to happen in
// complete silence.
// ─────────────────────────────────────────────────────────────────────────────

describe('noteWakeFailure', () => {
  beforeEach(() => {
    _resetWakeFailuresForTesting();
    upsertSessionRouting(db, { channel_type: 'telegram', platform_id: 'telegram:1', thread_id: null });
  });

  function notices(): string[] {
    return (db.prepare("SELECT content FROM messages_out WHERE kind = 'chat'").all() as { content: string }[]).map(
      (r) => (JSON.parse(r.content) as { text: string }).text,
    );
  }

  it('absorbs a short outage silently, then tells the user once', () => {
    const session = fakeSession();

    for (let i = 1; i < MAX_SILENT_WAKE_FAILURES; i++) {
      _noteWakeFailureForTesting(db, session);
      expect(notices()).toEqual([]);
    }

    _noteWakeFailureForTesting(db, session);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("I can't start up right now");

    // Still broken ten sweeps later — the user is told once per outage, not
    // once a minute forever.
    for (let i = 0; i < 10; i++) _noteWakeFailureForTesting(db, session);
    expect(notices()).toHaveLength(1);
  });

  it('says nothing for a session with no chat destination', () => {
    upsertSessionRouting(db, { channel_type: null, platform_id: null, thread_id: null });
    const session = fakeSession();
    for (let i = 0; i <= MAX_SILENT_WAKE_FAILURES; i++) _noteWakeFailureForTesting(db, session);
    expect(notices()).toEqual([]);
  });
});

/**
 * The digest's note has to be *deliverable*, which is a stricter thing than "queued".
 *
 * `deliverOne` throws on an outbound row with no `channel_type`/`platform_id`. A note queued
 * without them is a note the owner never sees, plus a delivery error on every sweep until the row
 * exhausts its attempts — and the digest itself would look like it had worked. So the sweep stamps
 * the session's own routing snapshot onto the row, and a session that has no snapshot yet gets no
 * note rather than an undeliverable one.
 */
describe('the memory digest note', () => {
  it('is queued with the session’s routing, so delivery can route it', () => {
    upsertSessionRouting(db, { channel_type: 'telegram', platform_id: '4242', thread_id: null });
    const routing = getSessionRoutingRow(db);

    insertOutboundMessage(db, {
      id: 'msg-digest-1',
      kind: 'chat',
      channel_type: routing.channel_type,
      platform_id: routing.platform_id,
      thread_id: routing.thread_id,
      content: '🧠 Memory: remembered `home/lease`',
    });

    const row = db
      .prepare('SELECT channel_type, platform_id, content FROM messages_out WHERE id = ?')
      .get('msg-digest-1') as { channel_type: string | null; platform_id: string | null; content: string };

    // Both present is the whole point — either one missing and delivery throws.
    expect(row.channel_type).toBe('telegram');
    expect(row.platform_id).toBe('4242');
    expect(row.content).toContain('home/lease');
  });

  it('has nowhere to send when the session was never routed', () => {
    // No `upsertSessionRouting` for this session: the snapshot is empty, and the sweep must skip
    // rather than queue a row that can only fail.
    const routing = getSessionRoutingRow(db);
    expect(routing.channel_type).toBeNull();
    expect(routing.platform_id).toBeNull();
  });
});
