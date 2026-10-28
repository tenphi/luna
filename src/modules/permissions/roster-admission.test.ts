/**
 * Admission, end to end: what happens to a DM depending on whether the roster names the sender.
 *
 * This is the behavior that replaced the Allow/Deny card, so it is worth testing through
 * `routeInbound` rather than at the unit level — the interesting parts are the order the gates run in
 * and what state each leaves behind.
 *
 * Covers:
 *  - a configured person's first DM wires itself and is delivered
 *  - a stranger's DM creates no wiring, is dropped, and the owner is told once
 *  - a disabled person is refused without bothering the owner
 *  - a group chat is never auto-wired, even for a configured sender
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { LunaConfigDoc } from '../../config/schema.js';

// eslint-disable-next-line no-var
var testConfig: LunaConfigDoc | undefined;
vi.mock('../../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/loader.js')>();
  return { ...actual, loadLunaConfig: () => testConfig ?? {} };
});

import { initTestDb, closeDb, initializeCentralSchema } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';

vi.mock('../../container-runner.js', async () => {
  const { fakeContainers } = await import('../../../test/support/containers.js');
  return fakeContainers();
});

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../delivery.js')>();
  return { ...actual, getDeliveryAdapter: () => ({ deliver: deliverMock }) };
});

vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    return getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-roster-admission' };
});

const TEST_DIR = '/tmp/luna-test-roster-admission';
const now = () => new Date().toISOString();

/** A DM: the chat id *is* the sender's id, which is what marks it as one. */
function dm(userId: string, handle: string, text = 'hello') {
  return {
    channelType: 'telegram',
    platformId: userId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        text,
        senderName: handle,
        author: { userId: userId.split(':')[1], userName: handle },
      }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  };
}

/** A group chat: a shared negative chat id, nobody's DM address. */
function group(text = '@bot hello') {
  return {
    channelType: 'telegram',
    platformId: 'telegram:-1001234',
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        text,
        senderName: 'memberhandle',
        author: { userId: '222', userName: 'memberhandle' },
      }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

async function wiringsFor(platformId: string): Promise<number> {
  const { getDb } = await import('../../db/connection.js');
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mg.platform_id = ?`,
    )
    .get(platformId) as { c: number };
  return row.c;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  initializeCentralSchema(db);

  await import('../index.js');

  createAgentGroup({ id: 'ag-1', name: 'Luna', agent_provider: null, created_at: now() });

  testConfig = {
    users: {
      ada: { name: 'Owner', telegramHandle: 'ownerhandle' },
      bo: { name: 'bo', telegramHandle: 'memberhandle' },
      formerflatmate: { name: 'Former', telegramHandle: 'formerhandle', enabled: false },
    },
    owner: 'ada',
  };

  // The owner is already bound and reachable, so notices have somewhere to go.
  upsertUser({
    id: 'telegram:111',
    kind: 'telegram',
    display_name: 'Owner',
    platform_username: 'ownerhandle',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'telegram:111',
    name: 'Owner DM',
    is_group: 0,
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare('INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)')
    .run('telegram:111', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('admission by roster', () => {
  it("wires a configured person's first DM without asking anyone", async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dm('telegram:222', 'memberhandle'));
    await new Promise((r) => setTimeout(r, 10));

    expect(await wiringsFor('telegram:222')).toBe(1);

    // No approval card: the question the card would ask was already answered in config.
    const { getDb } = await import('../../db/connection.js');
    const cards = (
      getDb().prepare("SELECT COUNT(*) AS c FROM pending_approvals WHERE kind = 'channel'").get() as { c: number }
    ).c;
    expect(cards).toBe(0);
  });

  it('binds that person to their config key on the way through', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dm('telegram:222', 'memberhandle'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const row = getDb().prepare('SELECT user_key FROM users WHERE id = ?').get('telegram:222') as {
      user_key: string | null;
    };
    expect(row.user_key).toBe('bo');
  });

  it('drops a stranger, wires nothing, and tells the owner once', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dm('telegram:999', 'strangerhandle'));
    await new Promise((r) => setTimeout(r, 20));

    expect(await wiringsFor('telegram:999')).toBe(0);

    const notices = deliverMock.mock.calls.filter((c) => String(c[4]).includes("isn't in your roster"));
    expect(notices).toHaveLength(1);
    // Actionable: it names the identity and the command that admits them.
    expect(String(notices[0][4])).toContain('luna config users set');
    expect(String(notices[0][4])).toContain('strangerhandle');

    // Second message from the same stranger: still dropped, but no second notice.
    deliverMock.mockClear();
    await routeInbound(dm('telegram:999', 'strangerhandle', 'still here'));
    await new Promise((r) => setTimeout(r, 20));
    expect(deliverMock.mock.calls.filter((c) => String(c[4]).includes("isn't in your roster"))).toHaveLength(0);
  });

  it('refuses a disabled person without bothering the owner', async () => {
    // The owner set `enabled: false` themselves; being told it took effect is noise.
    const { routeInbound } = await import('../../router.js');
    await routeInbound(dm('telegram:333', 'formerhandle'));
    await new Promise((r) => setTimeout(r, 20));

    expect(await wiringsFor('telegram:333')).toBe(0);
    expect(deliverMock.mock.calls.filter((c) => String(c[4]).includes("isn't in your roster"))).toHaveLength(0);
  });

  it('never auto-wires a group chat, even when the sender is configured', async () => {
    // A group is a shared chat id, so "should Luna listen here?" is a different question from "who
    // does Luna answer?" — and only the second one is settled by the roster. Auto-wiring it would set
    // engage_pattern '.', i.e. answering every message in a room on one member's account.
    const { routeInbound } = await import('../../router.js');
    await routeInbound(group());
    await new Promise((r) => setTimeout(r, 20));

    expect(await wiringsFor('telegram:-1001234')).toBe(0);

    // It escalates as a channel question instead.
    const { getDb } = await import('../../db/connection.js');
    const cards = (
      getDb().prepare("SELECT COUNT(*) AS c FROM pending_approvals WHERE kind = 'channel'").get() as { c: number }
    ).c;
    expect(cards).toBe(1);
  });
});
