import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { LunaConfigDoc } from './config/schema.js';

/**
 * Ownership comes from config now, so the roster is what these tests set up.
 *
 * `var`, not `let`: `vi.mock` is hoisted above this declaration and `src/config.ts` calls
 * `loadLunaConfig()` at import time, so a `let` binding is still in its temporal dead zone when the
 * first call lands. `var` hoists to `undefined` instead of throwing.
 */
// eslint-disable-next-line no-var
var testConfig: LunaConfigDoc | undefined;
vi.mock('./config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/loader.js')>();
  return { ...actual, loadLunaConfig: () => testConfig ?? {} };
});

import { closeDb, initTestDb, initializeCentralSchema } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { stampInboundPrivilege } from './router.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  initializeCentralSchema(db);
  testConfig = { users: { owner: { name: 'Owner', telegramHandle: 'ownerhandle' } }, owner: 'owner' };
});

afterEach(() => {
  closeDb();
});

describe('stampInboundPrivilege', () => {
  it('marks the configured owner as privileged', () => {
    createUser({
      id: 'telegram:1000000001',
      kind: 'telegram',
      display_name: 'Owner',
      platform_username: 'ownerhandle',
      created_at: now(),
    });
    const content = JSON.stringify({ text: 'hello', sender: 'Owner' });
    const out = JSON.parse(stampInboundPrivilege(content, 'telegram:1000000001')) as {
      _luna: { senderIsPrivileged: boolean; userId?: string };
    };
    expect(out._luna.senderIsPrivileged).toBe(true);
    expect(out._luna.userId).toBe('telegram:1000000001');
  });

  it("stamps the speaker's hot-memory page, named for their config key", () => {
    // The container cannot compute this: the page is named for the key in config/local.jsonc, and a
    // handle-derived `users/<handle>` would point at a different page than the one the host scaffolds.
    createUser({
      id: 'telegram:1000000001',
      kind: 'telegram',
      display_name: 'Owner',
      platform_username: 'ownerhandle',
      created_at: now(),
    });
    const out = JSON.parse(stampInboundPrivilege(JSON.stringify({ text: 'hi' }), 'telegram:1000000001')) as {
      _luna: { hotMemorySlug?: string };
    };
    expect(out._luna.hotMemorySlug).toBe('users/owner');
  });

  it('stamps no hot-memory page for someone the roster does not claim', () => {
    createUser({
      id: 'telegram:999',
      kind: 'telegram',
      display_name: 'Stranger',
      platform_username: 'stranger',
      created_at: now(),
    });
    const out = JSON.parse(stampInboundPrivilege(JSON.stringify({ text: 'hi' }), 'telegram:999')) as {
      _luna: { hotMemorySlug?: string };
    };
    expect(out._luna.hotMemorySlug).toBeUndefined();
  });

  it('marks the local CLI identity as privileged without a roster entry', () => {
    testConfig = {};
    const out = JSON.parse(stampInboundPrivilege(JSON.stringify({ text: 'hi' }), 'cli:local')) as {
      _luna: { senderIsPrivileged: boolean };
    };
    expect(out._luna.senderIsPrivileged).toBe(true);
  });

  it('marks members as not privileged', () => {
    const content = JSON.stringify({ text: 'hello', sender: 'Member' });
    const out = JSON.parse(stampInboundPrivilege(content, 'telegram:member')) as {
      _luna: { senderIsPrivileged: boolean; userId?: string };
    };
    expect(out._luna.senderIsPrivileged).toBe(false);
    expect(out._luna.userId).toBe('telegram:member');
  });

  it('marks null userId as not privileged', () => {
    const content = JSON.stringify({ text: 'cron' });
    const out = JSON.parse(stampInboundPrivilege(content, null)) as {
      _luna: { senderIsPrivileged: boolean; userId?: string };
    };
    expect(out._luna.senderIsPrivileged).toBe(false);
    expect(out._luna.userId).toBeUndefined();
  });

  it('stamps episode eligibility when the caller decided it', () => {
    const content = JSON.stringify({ text: 'hello' });
    const enabled = JSON.parse(stampInboundPrivilege(content, 'cli:local', { episodesEnabled: true })) as {
      _luna: { episodesEnabled?: boolean };
    };
    const disabled = JSON.parse(stampInboundPrivilege(content, 'cli:local', { episodesEnabled: false })) as {
      _luna: { episodesEnabled?: boolean };
    };
    const unset = JSON.parse(stampInboundPrivilege(content, 'cli:local')) as {
      _luna: { episodesEnabled?: boolean };
    };

    expect(enabled._luna.episodesEnabled).toBe(true);
    expect(disabled._luna.episodesEnabled).toBe(false);
    expect(unset._luna.episodesEnabled).toBeUndefined();
  });

  it('wraps non-JSON content so privilege is still readable', () => {
    const plain = 'plain text with no JSON envelope';
    const out = JSON.parse(stampInboundPrivilege(plain, 'cli:local')) as {
      text: string;
      _luna: { senderIsPrivileged: boolean };
    };
    expect(out.text).toBe(plain);
    expect(out._luna.senderIsPrivileged).toBe(true);
  });
});
