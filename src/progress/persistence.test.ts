/**
 * Stranded progress bubbles.
 *
 * A host that dies mid-turn leaves a "🤔 Thinking…" message on the user's
 * screen with nothing left in memory to ever close it. These tests cover the
 * durable record that makes the next boot able to find it.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-progress-persistence' };
});

const TEST_DIR = '/tmp/luna-test-progress-persistence';

import { initTestDb, closeDb, initializeCentralSchema, createAgentGroup, createMessagingGroup } from '../db/index.js';
import { getSessionState, setSessionState } from '../db/session-db.js';
import { openSession, resolveSession } from '../session-manager.js';
import {
  createProgressSession,
  destroyProgressSession,
  finalizeProgressSession,
  handleStatusEvent,
  setProgressPersistence,
  type ProgressSink,
} from './controller.js';
import { installProgressPersistence, reconcileOrphanedProgressBubbles } from './persistence.js';
import { setProgressSinkFactory } from './status-events.js';

const KEY = 'progress:live';

interface RecordingSink extends ProgressSink {
  sends: string[];
  edits: Array<{ id: string; text: string }>;
}

function makeSink(): RecordingSink {
  const sink: RecordingSink = {
    isCli: false,
    sends: [],
    edits: [],
    async sendStatus(text: string) {
      sink.sends.push(text);
      return `plat-msg-${sink.sends.length}`;
    },
    async editStatus(id: string, text: string) {
      sink.edits.push({ id, text });
    },
  };
  return sink;
}

let sink: RecordingSink;
let sessionId: string;

function liveRecord(): Record<string, unknown> | null {
  const db = openSession('ag-1', sessionId);
  try {
    const raw = getSessionState(db, KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  initializeCentralSchema(db);

  const now = new Date().toISOString();
  createAgentGroup({ id: 'ag-1', name: 'Test Agent', agent_provider: null, created_at: now });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    created_at: now,
  });
  sessionId = resolveSession('ag-1', 'mg-1', null, 'shared').session.id;

  sink = makeSink();
  setProgressSinkFactory(() => sink);
  installProgressPersistence();
});

afterEach(() => {
  destroyProgressSession(sessionId);
  setProgressPersistence(null);
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('live bubble record', () => {
  it('records the bubble as soon as it reaches the user', async () => {
    createProgressSession(sessionId, Date.now(), sink, {
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
      anchor: 'msg-in-1',
    });
    await handleStatusEvent(sessionId, { phase: 'tool', name: 'mcp__memory__search', args: {} });

    expect(sink.sends).toHaveLength(1);
    expect(liveRecord()).toMatchObject({
      messageId: 'plat-msg-1',
      channelType: 'telegram',
      platformId: 'telegram:123',
      anchor: 'msg-in-1',
    });
  });

  it('forgets the bubble once the turn ends normally', async () => {
    createProgressSession(sessionId, Date.now(), sink, {
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
    });
    await handleStatusEvent(sessionId, { phase: 'tool', name: 'mcp__memory__search', args: {} });
    expect(liveRecord()).not.toBeNull();

    await finalizeProgressSession(sessionId);

    // Nothing left for the next boot to "fix" — a finished turn's Done summary
    // must not be overwritten with a restart notice.
    expect(liveRecord()).toBeNull();
  });

  it('writes nothing when the bubble was never shown', async () => {
    createProgressSession(sessionId, Date.now(), sink, {
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
    });
    await handleStatusEvent(sessionId, { phase: 'thinking' });

    expect(sink.sends).toHaveLength(0);
    expect(liveRecord()).toBeNull();
  });
});

describe('reconcileOrphanedProgressBubbles', () => {
  function strand(messageId = 'plat-stranded'): void {
    const db = openSession('ag-1', sessionId);
    setSessionState(
      db,
      KEY,
      JSON.stringify({
        messageId,
        channelType: 'telegram',
        platformId: 'telegram:123',
        threadId: null,
        t0: Date.now() - 60_000,
        anchor: 'msg-in-1',
      }),
    );
    db.close();
  }

  it('closes a bubble the previous run left ticking', async () => {
    strand();

    await expect(reconcileOrphanedProgressBubbles()).resolves.toBe(1);

    expect(sink.edits).toHaveLength(1);
    expect(sink.edits[0]!.id).toBe('plat-stranded');
    expect(sink.edits[0]!.text).toContain('Interrupted');
    expect(sink.edits[0]!.text).toContain('restarted');
  });

  it('does not re-close the same bubble on every boot', async () => {
    strand();
    await reconcileOrphanedProgressBubbles();
    sink.edits.length = 0;

    await expect(reconcileOrphanedProgressBubbles()).resolves.toBe(0);
    expect(sink.edits).toHaveLength(0);
  });

  it('clears the record even when the edit fails, so it cannot strand forever', async () => {
    strand();
    sink.editStatus = async () => {
      throw new Error('message to edit not found');
    };

    await expect(reconcileOrphanedProgressBubbles()).resolves.toBe(0);
    expect(liveRecord()).toBeNull();
  });

  it('is a no-op when no session has a live bubble', async () => {
    await expect(reconcileOrphanedProgressBubbles()).resolves.toBe(0);
    expect(sink.edits).toHaveLength(0);
  });
});
