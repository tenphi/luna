/**
 * cli_command approval handler — re-dispatches approved frames as host.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

// The fixture creates two agent groups, so the real single-agent getTheAgent()
// throws. The approval re-dispatch runs as `host`, which resolves the group
// through it, so pin it to the source group.
vi.mock('../bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bootstrap.js')>();
  return { ...actual, getTheAgent: () => ({ id: 'ag-source', name: 'source' }) };
});

// config-agent-add-package persists to the real `agent/container.json`, so keep
// the stored config in memory — a test must not mutate the working tree.
const storedPackages = { apt: [] as string[], npm: [] as string[] };
const mockUpdateStoredContainerConfig = vi.fn();
vi.mock('../container-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../container-config.js')>();
  return {
    ...actual,
    readStoredContainerConfig: () => ({
      mcpServers: {},
      packages: storedPackages,
      additionalMounts: [],
      skills: 'all',
      cliScope: 'agent',
    }),
    updateStoredContainerConfig: (...args: unknown[]) => mockUpdateStoredContainerConfig(...args),
  };
});

vi.mock('../modules/approvals/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/approvals/index.js')>();
  return {
    ...actual,
    requestApproval: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-cli-approval' };
});

const TEST_DIR = '/tmp/luna-test-cli-approval';

import { buildAgentGroupImage } from '../container-runner.js';
import { initTestDb, closeDb, initializeCentralSchema, createAgentGroup, getDb } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { initSessionFolder, sessionDbPath, sessionDir } from '../session-manager.js';
import { dispatch } from './dispatch.js';
import { applyCliCommand } from './approval-handler.js';
import './resources/destinations.js';
import './commands/agent-config.js';

function now(): string {
  return new Date().toISOString();
}

function readCliResponse(agentGroupId: string, sessionId: string, requestId: string) {
  const db = new Database(sessionDbPath(agentGroupId, sessionId), { readonly: true });
  const row = db.prepare('SELECT content FROM messages_in WHERE content LIKE ?').get(`%"requestId":"${requestId}"%`) as
    | { content: string }
    | undefined;
  db.close();
  if (!row) return null;
  return JSON.parse(row.content) as { type: string; requestId: string; frame: { ok: boolean } };
}

describe('cli_command approval handler', () => {
  const SOURCE = 'ag-source';
  const TARGET = 'ag-target';
  const SESSION = 'sess-source-1';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Session dirs follow the mocked DATA_DIR, so they sit under TEST_DIR and
    // cannot collide with another test file's identical fixture ids. Clearing
    // them anyway keeps a leftover session.db from a killed run out of the way.
    fs.rmSync(sessionDir(SOURCE, SESSION), { recursive: true, force: true });

    const db = initTestDb();
    initializeCentralSchema(db);

    createAgentGroup({ id: SOURCE, name: 'source', agent_provider: null, created_at: now() });
    createAgentGroup({ id: TARGET, name: 'target', agent_provider: null, created_at: now() });

    createSession({
      id: SESSION,
      agent_group_id: SOURCE,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(SOURCE, SESSION);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.rmSync(sessionDir(SOURCE, SESSION), { recursive: true, force: true });
  });

  it('re-dispatches approved destinations-add as host and writes cli_response', async () => {
    const requestId = 'req-approval-1';
    const frame = {
      id: requestId,
      command: 'destinations-add',
      args: {
        agent_group_id: SOURCE,
        local_name: 'helper',
        target_type: 'agent',
        target_id: TARGET,
      },
    };

    const pending = await dispatch(frame, {
      caller: 'agent',
      sessionId: SESSION,
      agentGroupId: SOURCE,
      messagingGroupId: 'mg1',
    });
    expect(pending.ok).toBe(false);
    if (pending.ok) return;
    expect(pending.error.code).toBe('approval-pending');

    await applyCliCommand({
      session: {
        id: SESSION,
        agent_group_id: SOURCE,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now(),
      },
      payload: { frame },
      userId: 'admin-1',
      notify: vi.fn(),
      selectedOption: 'approve',
    });

    const row = getDb().prepare('SELECT local_name FROM agent_destinations WHERE agent_group_id = ?').get(SOURCE) as
      | { local_name: string }
      | undefined;
    expect(row?.local_name).toBe('helper');

    const cliResp = readCliResponse(SOURCE, SESSION, requestId);
    expect(cliResp?.type).toBe('cli_response');
    expect(cliResp?.frame.ok).toBe(true);
  });

  // The cli_response row is a dead letter for approvals — the container's
  // `luna` process stopped polling after 30s and exited. Without an explicit
  // notify, an approved config change lands and the agent never finds out.
  describe('post-approval notification', () => {
    const session = () => ({
      id: SESSION,
      agent_group_id: SOURCE,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active' as const,
      container_status: 'stopped' as const,
      last_active: null,
      created_at: now(),
    });

    it('tells the agent when a recorded package change is approved', async () => {
      const notify = vi.fn();
      await applyCliCommand({
        session: session(),
        payload: {
          frame: { id: 'req-pkg-1', command: 'config-agent-add-package', args: { group: SOURCE, apt: 'imagemagick' } },
        },
        userId: 'admin-1',
        notify,
        selectedOption: 'approve',
      });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toContain('config agent add package');
    });

    it('stays quiet when --rebuild was used, since the respawn carries its own message', async () => {
      const notify = vi.fn();
      await applyCliCommand({
        session: session(),
        payload: {
          frame: {
            id: 'req-pkg-2',
            command: 'config-agent-add-package',
            args: { group: SOURCE, apt: 'imagemagick', rebuild: 'true' },
          },
        },
        userId: 'admin-1',
        notify,
        selectedOption: 'approve',
      });

      expect(vi.mocked(buildAgentGroupImage)).toHaveBeenCalledWith(SOURCE);
      expect(notify).not.toHaveBeenCalled();
    });

    it('does not notify for commands whose effect the agent can already see', async () => {
      const notify = vi.fn();
      await applyCliCommand({
        session: session(),
        payload: {
          frame: {
            id: 'req-dest-2',
            command: 'destinations-add',
            args: { agent_group_id: SOURCE, local_name: 'helper2', target_type: 'agent', target_id: TARGET },
          },
        },
        userId: 'admin-1',
        notify,
        selectedOption: 'approve',
      });

      expect(notify).not.toHaveBeenCalled();
    });
  });
});
