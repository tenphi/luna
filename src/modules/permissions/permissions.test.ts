/**
 * Tests for the permissions module — canAccessAgentGroup, the config roster, and ensureUserDm.
 *
 * The access tests changed shape when the roster moved into config: there is no longer a `grantRole`
 * to call or a membership row to insert, so they configure `users`/`owner` and assert what the gate
 * makes of an inbound identity.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import type { LunaConfigDoc } from '../../config/schema.js';

/** Swapped per test; `loadLunaConfig` is the only thing the roster reads. */
let testConfig: LunaConfigDoc = {};
vi.mock('../../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/loader.js')>();
  return { ...actual, loadLunaConfig: () => testConfig };
});

import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  initTestDb,
  initializeCentralSchema,
} from '../../db/index.js';
import { canAccessAgentGroup } from './access.js';
import { createUser } from './db/users.js';
import { getUserDm } from './db/user-dms.js';
import { ensureUserDm } from './user-dm.js';
import { isOwner, ownerIdentities, resolveUserKey } from '../../users/binding.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  initializeCentralSchema(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

async function mountMockAdapter(channelType: string, openDM?: (handle: string) => Promise<string>) {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const resolve = openDM ? vi.fn(openDM) : undefined;
  const adapter: ChannelAdapter = {
    channelType,
    name: `Fixture ${channelType}`,
    supportsThreads: false,
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    deliver,
    ...(resolve ? { openDM: resolve } : {}),
  };
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({ onAction() {}, onMetadata() {}, onInbound() {}, onInboundEvent() {} }));
  return {
    get delivered(): OutboundMessage[] {
      return deliver.mock.calls.map((call) => call[2]);
    },
    get openDMCalls(): string[] {
      return resolve?.mock.calls.map((call) => call[0]) ?? [];
    },
  };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string, platformUsername?: string): void {
  createUser({ id, kind, display_name: null, platform_username: platformUsername ?? null, created_at: now() });
}

const ROSTER: LunaConfigDoc = {
  users: {
    ada: { name: 'Ada Marlow', telegramHandle: 'ada_marlow' },
    bo: { name: 'bo', telegramHandle: 'bo_luna' },
  },
  owner: 'ada',
};

describe('canAccessAgentGroup', () => {
  beforeEach(() => {
    testConfig = ROSTER;
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('denies an identity with no row at all', () => {
    const d = canAccessAgentGroup('telegram:ghost', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('unknown_user');
  });

  it('denies a known identity the roster does not claim', () => {
    // Seen before, has a row, handle is simply not in config. This is the case that used to send the
    // owner an Allow/Deny card.
    seedUser('telegram:999', 'telegram', 'stranger');
    const d = canAccessAgentGroup('telegram:999', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('unknown_user');
  });

  it('allows the configured owner, on any agent group', () => {
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    expect(canAccessAgentGroup('telegram:1000000001', 'ag-1')).toEqual({ allowed: true, reason: 'owner' });
    expect(canAccessAgentGroup('telegram:1000000001', 'ag-2')).toEqual({ allowed: true, reason: 'owner' });
  });

  it('allows a configured non-owner, on any agent group', () => {
    // The per-group grain is gone: being in the roster is the whole test.
    seedUser('telegram:1000000002', 'telegram', 'bo_luna');
    expect(canAccessAgentGroup('telegram:1000000002', 'ag-1')).toEqual({ allowed: true, reason: 'member' });
    expect(canAccessAgentGroup('telegram:1000000002', 'ag-2')).toEqual({ allowed: true, reason: 'member' });
  });

  it('refuses a disabled user distinguishably from an unknown one', () => {
    testConfig = {
      users: { ada: { telegramHandle: 'ada_marlow' }, bob: { telegramHandle: 'bob', enabled: false } },
      owner: 'ada',
    };
    seedUser('telegram:555', 'telegram', 'bob');
    const d = canAccessAgentGroup('telegram:555', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('user_disabled');
  });

  it('allows the local CLI identity with no row and no roster entry', () => {
    // Host access is the credential. This must hold even for an install whose config names nobody,
    // because the terminal is how a broken roster gets fixed.
    testConfig = {};
    expect(canAccessAgentGroup('cli:local', 'ag-1')).toEqual({ allowed: true, reason: 'owner' });
  });
});

describe('roster binding', () => {
  beforeEach(() => {
    testConfig = ROSTER;
    seedAgentGroup('ag-1');
  });

  it('binds a handle to a config key and records it', () => {
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');
    // Second call takes the stored path; the answer must not change.
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');
  });

  it('keeps a binding after the handle changes', () => {
    // Same person, new @username. Re-deriving from the handle every time would lose them.
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');

    testConfig = { users: { ada: { telegramHandle: 'ada_marlow-new' } }, owner: 'ada' };
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');
  });

  it('stops resolving when the person is removed from config', () => {
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');

    testConfig = { users: { bo: { telegramHandle: 'bo_luna' } }, owner: 'bo' };
    expect(resolveUserKey('telegram:1000000001')).toBeNull();
  });

  it('refuses a second identity on the same channel claiming a taken key', () => {
    // Telegram handles are recyclable and platform_username is never cleared, so without
    // first-binding-wins a released handle would hand a stranger someone else's config entry.
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    expect(resolveUserKey('telegram:1000000001')).toBe('ada');

    seedUser('telegram:70000', 'telegram', 'ada_marlow');
    expect(resolveUserKey('telegram:70000')).toBeNull();
  });

  it('reports the owner as owner and everyone else as not', () => {
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    seedUser('telegram:1000000002', 'telegram', 'bo_luna');
    expect(isOwner('telegram:1000000001')).toBe(true);
    expect(isOwner('telegram:1000000002')).toBe(false);
    expect(isOwner('cli:local')).toBe(true);
  });

  it('lists only the owner’s identities as reachable', () => {
    seedUser('telegram:1000000001', 'telegram', 'ada_marlow');
    seedUser('telegram:1000000002', 'telegram', 'bo_luna');
    resolveUserKey('telegram:1000000001');
    resolveUserKey('telegram:1000000002');
    expect(ownerIdentities()).toEqual(['telegram:1000000001']);
  });

  it('has no owner identities before the owner has ever messaged', () => {
    // Config alone cannot make someone reachable — pickApprover appends cli:local for this case.
    expect(ownerIdentities()).toEqual([]);
  });
});

describe('private conversation resolution', () => {
  it.each([
    ['nodm', 'nodm:123', undefined, '123'],
    ['telegram', 'telegram:1000000003', undefined, 'telegram:1000000003'],
    ['telegram', 'telegram:1000000004', 'telegram:resolved', 'telegram:resolved'],
  ] as const)('resolves and caches the %s transport address', async (channel, identity, resolved, expected) => {
    const adapter = await mountMockAdapter(channel, resolved ? async () => resolved : undefined);
    seedUser(identity, channel);
    const first = await ensureUserDm(identity);
    const second = await ensureUserDm(identity);
    expect(first?.platform_id).toBe(expected);
    expect(second?.id).toBe(first?.id);
    expect(first?.is_group).toBe(0);
    expect(getUserDm(identity, channel)?.messaging_group_id).toBe(first?.id);
    expect(adapter.openDMCalls.length).toBe(resolved ? 1 : 0);
  });
  it('uses a known conversation and refuses a failing transport without caching it', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:555', 'telegram');
    createMessagingGroup({
      id: 'existing-fixture',
      channel_type: 'telegram',
      platform_id: 'telegram:555',
      name: 'Existing fixture conversation',
      is_group: 0,
      created_at: now(),
    });
    expect((await ensureUserDm('telegram:555'))?.id).toBe('existing-fixture');
    await mountMockAdapter('cli', async () => {
      throw new Error('synthetic transport failure');
    });
    seedUser('cli:unreachable', 'cli');
    expect(await ensureUserDm('cli:unreachable')).toBeNull();
    expect(getUserDm('cli:unreachable', 'cli')).toBeUndefined();
  });
  it('refuses unknown identities and missing transports', async () => {
    expect(await ensureUserDm('missing:fixture')).toBeNull();
    seedUser('missing:fixture', 'missing');
    expect(await ensureUserDm('missing:fixture')).toBeNull();
  });
});
