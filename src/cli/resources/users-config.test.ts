/**
 * `luna config users …` and `luna users bind` — the roster from the terminal.
 *
 * These write real files through `writeLocalConfig`, because the thing worth testing is the round trip:
 * a `users` section that parses back and a per-key merge that does not drop the people already there.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = '/tmp/luna-test-users-config';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

// Literals, not `TEST_DIR`: vi.mock factories are hoisted above the const declaration.
vi.mock('../../install-paths.js', () => ({
  getAgentDir: () => '/tmp/luna-test-users-config/agent',
  getExternalMcpsImportPath: () => '/tmp/luna-test-users-config/external-mcps.json',
  getMountAllowlistPath: () => '/tmp/luna-test-users-config/mount-allowlist.json',
}));

vi.mock('../../config/paths.js', () => ({
  configDir: () => '/tmp/luna-test-users-config/config',
  defaultConfigPath: () => '/tmp/luna-test-users-config/config/default.jsonc',
  localConfigPath: () => '/tmp/luna-test-users-config/config/local.jsonc',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-users-config' };
});

// The install agent runs at `cliScope: 'global'`, which skips the resource whitelist in dispatch.ts.
// That is the scope the host-only guard has to hold at, so it is the scope these tests use.
vi.mock('../../container-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../container-config.js')>();
  return { ...actual, readStoredContainerConfig: () => ({ cliScope: 'global' }) };
});

import { clearConfigCache } from '../../config/loader.js';
import { initTestDb, closeDb, initializeCentralSchema, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './config.js';
import './users.js';

const LOCAL = path.join(TEST_DIR, 'config', 'local.jsonc');

interface UsersStatus {
  owner: string | null;
  users: { key: string; telegram_handle: string | null; enabled: boolean; is_owner: boolean }[];
  problems: string[];
}

async function run(command: string, args: Record<string, unknown> = {}) {
  const resp = await dispatch({ id: 'r', command, args }, { caller: 'host' });
  return resp;
}

async function set(args: Record<string, unknown>): Promise<UsersStatus> {
  const resp = await run('config-users-set', args);
  if (!resp.ok) throw new Error(resp.error.message);
  return resp.data as UsersStatus;
}

beforeEach(() => {
  clearConfigCache();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'config'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'config', 'default.jsonc'), JSON.stringify({ users: {}, owner: null }));
  const db = initTestDb();
  initializeCentralSchema(db);
  db.prepare('INSERT INTO agent_groups (id, name, agent_provider, created_at) VALUES (?, ?, ?, ?)').run(
    'ag-1',
    'Luna',
    null,
    new Date().toISOString(),
  );
});

afterEach(() => {
  closeDb();
  clearConfigCache();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('luna config users', () => {
  it('adds a person and makes them the owner', async () => {
    const status = await set({ key: 'ada', name: 'Ada Marlow', 'telegram-handle': '@ada_marlow', owner: true });

    expect(status.owner).toBe('ada');
    expect(status.users).toHaveLength(1);
    expect(status.users[0]).toMatchObject({ key: 'ada', telegram_handle: 'ada_marlow', is_owner: true });
    expect(status.problems).toEqual([]);

    // The @ is stripped on the way in, so it matches what the platform reports.
    expect(fs.readFileSync(LOCAL, 'utf-8')).toContain('"telegramHandle": "ada_marlow"');
  });

  it('adds a second person without disturbing the first', async () => {
    await set({ key: 'ada', name: 'Ada', 'telegram-handle': 'ada_marlow', owner: true });
    const status = await set({ key: 'bo', name: 'bo', 'telegram-handle': 'bo_luna' });

    expect(status.users.map((u) => u.key).sort()).toEqual(['ada', 'bo']);
    expect(status.owner).toBe('ada');
  });

  it('changes one field and leaves the rest alone', async () => {
    await set({ key: 'ada', name: 'Ada', 'telegram-handle': 'ada_marlow', owner: true });
    await set({ key: 'ada', 'memory-page': 'people/ada-marlow' });

    const local = JSON.parse(fs.readFileSync(LOCAL, 'utf-8')) as {
      users: Record<string, Record<string, unknown>>;
    };
    expect(local.users.ada).toEqual({
      name: 'Ada',
      telegramHandle: 'ada_marlow',
      memoryPage: 'people/ada-marlow',
    });
  });

  it('disables someone without removing them', async () => {
    await set({ key: 'ada', 'telegram-handle': 'ada_marlow', owner: true });
    const status = await set({ key: 'bob', 'telegram-handle': 'bob', enabled: 'false' });

    expect(status.users.find((u) => u.key === 'bob')?.enabled).toBe(false);
  });

  it('refuses an agent at global scope outright, with no approval card', async () => {
    // Approving a roster change is the admission-by-tap this design removed — the same decision the
    // Allow/Deny card used to ask, wearing different clothes. So there is no card: the call is refused.
    const resp = await dispatch(
      { id: 'r', command: 'config-users-set', args: { key: 'intruder', 'telegram-handle': 'x' } },
      { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'm' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('edited on the host');
      expect(resp.error.code).not.toBe('approval-pending');
    }
    // And nothing was written — the local overlay was never even created.
    expect(fs.existsSync(LOCAL)).toBe(false);
  });

  it('refuses an agent at global scope for remove and bind too', async () => {
    for (const command of ['config-users-remove', 'users-bind']) {
      const resp = await dispatch(
        { id: 'r', command, args: { key: 'ada', user: 'telegram:1' } },
        { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'm' },
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).not.toBe('approval-pending');
    }
  });

  it('refuses a set with no fields', async () => {
    const resp = await run('config-users-set', { key: 'ada' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('Nothing to update');
  });

  it('reports a broken roster rather than refusing the write', async () => {
    // Half a roster is still worth saving: refusing would leave no way to fix it one flag at a time.
    const status = await set({ key: 'bo', 'telegram-handle': 'bo_luna' });
    expect(status.problems.join(' ')).toContain('owner is not set');
  });

  it('removes a person, but not the owner', async () => {
    await set({ key: 'ada', 'telegram-handle': 'ada_marlow', owner: true });
    await set({ key: 'bo', 'telegram-handle': 'bo_luna' });

    const removed = await run('config-users-remove', { key: 'bo' });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect((removed.data as UsersStatus).users.map((u) => u.key)).toEqual(['ada']);
    }

    const refused = await run('config-users-remove', { key: 'ada' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('is the owner');
  });
});

describe('luna users bind', () => {
  beforeEach(async () => {
    await set({ key: 'ada', name: 'Ada', 'telegram-handle': 'ada_marlow', owner: true });
    await set({ key: 'nohandle', name: 'No Handle' });
  });

  it('attaches an identity that the roster cannot match on its own', async () => {
    // The case this exists for: a Telegram account with no public @username exposes no handle, so
    // automatic matching can never claim it.
    getDb()
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run('telegram:555', 'telegram', 'No Handle', new Date().toISOString());

    const resp = await run('users-bind', { user: 'telegram:555', key: 'nohandle' });
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { resolves_to: string }).resolves_to).toBe('nohandle');
    }
  });

  it('refuses a key that is not configured', async () => {
    getDb()
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run('telegram:555', 'telegram', 'Someone', new Date().toISOString());

    const resp = await run('users-bind', { user: 'telegram:555', key: 'ghost' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('No configured user "ghost"');
  });

  it('refuses an identity that has never been seen', async () => {
    const resp = await run('users-bind', { user: 'telegram:404', key: 'nohandle' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toContain('has been seen');
  });
});
