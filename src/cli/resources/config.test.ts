/**
 * Unified config CLI (install-wide topics).
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../install-paths.js', () => ({
  getAgentDir: () => '/tmp/luna-test-cli-config/agent',
  getExternalMcpsImportPath: () => '/tmp/luna-test-cli-config/external-mcps.json',
  getMountAllowlistPath: () => '/tmp/luna-test-cli-config/mount-allowlist.json',
}));

vi.mock('../../config/paths.js', () => ({
  configDir: () => '/tmp/luna-test-cli-config/config',
  defaultConfigPath: () => '/tmp/luna-test-cli-config/config/default.jsonc',
  localConfigPath: () => '/tmp/luna-test-cli-config/config/local.jsonc',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/luna-test-cli-config',
  };
});

const TEST_DIR = '/tmp/luna-test-cli-config';

import { clearConfigCache } from '../../config/loader.js';
import { initTestDb, closeDb, initializeCentralSchema, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './config.js';
vi.mock('../../host-mcp/builtins/email/shared/imap/preview.js', () => ({
  previewMailExclusions: vi.fn(async (mailbox, since, until) => ({
    mailbox: mailbox.key,
    since,
    until,
    matchedMessages: 10,
    includedMessages: 2,
    excludedMessages: 8,
  })),
}));

describe('config mcp-tools', () => {
  it('sets additive per-mailbox exclusions without dropping credentials or other roster fields', async () => {
    fs.writeFileSync(
      path.join(TEST_DIR, 'config/local.jsonc'),
      JSON.stringify({
        email: { enabled: true, ignoreLabels: ['Global'] },
        users: { ada: { name: 'Ada Marlow', email: { address: 'ada@example.test', appPassword: 'fixture' } } },
      }),
    );
    clearConfigCache();
    const result = await dispatch(
      {
        id: 'mail-exclusions',
        command: 'config-email-set',
        args: { mailbox: 'ada', 'ignore-labels': '["Work updates"]', 'ignore-senders': 'notice@example.test' },
      },
      { caller: 'host' },
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result).toMatchObject({ ok: true });
    const config = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'config/local.jsonc'), 'utf8'));
    expect(config.email.ignoreLabels).toEqual(['Global']);
    expect(config.users.ada).toMatchObject({
      name: 'Ada Marlow',
      email: {
        address: 'ada@example.test',
        appPassword: 'fixture',
        ignoreLabels: ['Work updates'],
        ignoreSenders: ['notice@example.test'],
      },
    });
    const preview = await dispatch(
      { id: 'mail-preview', command: 'config-email-preview', args: { mailbox: 'ada', since: '2031-04-02' } },
      { caller: 'host' },
    );
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('fixture');
  });
  beforeEach(() => {
    clearConfigCache();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'config'), { recursive: true });
    const db = initTestDb();
    initializeCentralSchema(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('lists config topics from bare luna config', async () => {
    const resp = await dispatch({ id: 'req-topics', command: 'config', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { topics: Array<{ topic: string }> } }).data;
    expect(data.topics.map((t) => t.topic)).toContain('memory');
    expect(data.topics.map((t) => t.topic)).toContain('agent');
  });

  it('set and get an install-wide tool allowlist', async () => {
    const setResp = await dispatch(
      {
        id: 'req-set',
        command: 'config-mcp-tools-set',
        args: { name: 'memory', allow: '["recall","read"]' },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);

    const row = getDb().prepare('SELECT mcp_tool_filters FROM install_settings WHERE id = 1').get() as {
      mcp_tool_filters: string;
    };
    const filters = JSON.parse(row.mcp_tool_filters) as Record<string, { toolsAllow?: string[] }>;
    expect(filters.memory.toolsAllow).toEqual(['recall', 'read']);

    const getResp = await dispatch({ id: 'req-get', command: 'config-mcp-tools-get', args: {} }, { caller: 'host' });
    expect(getResp.ok).toBe(true);
    const data = (getResp as { ok: true; data: { mcp_tool_filters: typeof filters } }).data;
    expect(data.mcp_tool_filters.memory.toolsAllow).toEqual(['recall', 'read']);
  });

  it('accepts comma-separated allow lists', async () => {
    const resp = await dispatch(
      {
        id: 'req-comma',
        command: 'config-mcp-tools-set',
        args: { name: 'luna', allow: 'send_message,schedule_task' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);

    const row = getDb().prepare('SELECT mcp_tool_filters FROM install_settings WHERE id = 1').get() as {
      mcp_tool_filters: string;
    };
    const filters = JSON.parse(row.mcp_tool_filters) as Record<string, { toolsAllow?: string[] }>;
    expect(filters.luna.toolsAllow).toEqual(['send_message', 'schedule_task']);
  });

  it('topic shorthand resolves to get', async () => {
    const resp = await dispatch({ id: 'req-shorthand', command: 'config-memory', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { memory: { socket: string }; service: { reachable: boolean } } }).data;
    expect(data.memory.socket).toBeTruthy();
    // Reachability is reported, never asserted: there is no memory service in a test run, and
    // "unreachable" is a legitimate answer this command has to be able to give.
    expect(data.service).toBeDefined();
  });

  it('sets and gets the memory settings Luna owns', async () => {
    const setResp = await dispatch(
      {
        id: 'req-memory-set',
        command: 'config-memory-set',
        args: {
          auto_recall: 'false',
          digest: 'false',
          notify: 'off',
          mission: 'Household logistics matter here.',
        },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);

    const local = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'config/local.jsonc'), 'utf-8')) as {
      memory?: { autoRecall?: boolean; digest?: boolean; notify?: string; mission?: string };
    };
    expect(local.memory?.autoRecall).toBe(false);
    expect(local.memory?.digest).toBe(false);
    expect(local.memory?.notify).toBe('off');
    expect(local.memory?.mission).toBe('Household logistics matter here.');

    const getResp = await dispatch(
      { id: 'req-memory-get', command: 'config-memory-get', args: {} },
      { caller: 'host' },
    );
    expect(getResp.ok).toBe(true);
    const data = (getResp as { ok: true; data: { memory: { autoRecall: boolean; digest: boolean; notify: string } } })
      .data;
    expect(data.memory.autoRecall).toBe(false);
    expect(data.memory.digest).toBe(false);
    expect(data.memory.notify).toBe('off');
  });

  it('refuses a notify value it does not understand', async () => {
    const resp = await dispatch(
      { id: 'req-memory-bad', command: 'config-memory-set', args: { notify: 'verbose' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
  });

  it('sets install-wide provider defaults in local config', async () => {
    const setResp = await dispatch(
      {
        id: 'req-defaults-set',
        command: 'config-set',
        args: { provider: 'custom', model: 'custom-model', 'base-url': 'https://api.example.com/v1' },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);

    const local = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'config/local.jsonc'), 'utf-8')) as {
      models?: { main?: { provider?: string; id?: string } };
      providers?: { openai?: { baseUrl?: string } };
    };
    expect(local).toMatchObject({
      models: { main: { provider: 'custom', id: 'custom-model' } },
      providers: { openai: { baseUrl: 'https://api.example.com/v1' } },
    });
  });

  it('sets the model role via config models set', async () => {
    const setResp = await dispatch(
      {
        id: 'req-models-set',
        command: 'config-models-set',
        args: { role: 'main', id: 'openai:gpt-4o-mini', provider: 'openai' },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);

    const local = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'config/local.jsonc'), 'utf-8')) as {
      models?: { main?: { id?: string; provider?: string } };
    };
    // The `provider:` prefix is stripped — the provider is a separate field, and carrying it in the
    // id was how two spellings of the same choice got out of step.
    expect(local.models?.main).toEqual({ provider: 'openai', id: 'gpt-4o-mini' });
  });

  it('refuses a role that does not exist', async () => {
    const resp = await dispatch(
      { id: 'req-models-bad', command: 'config-models-set', args: { role: 'embedding', id: 'x' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
  });

  it('sets and gets host MCP wiring', async () => {
    const setResp = await dispatch(
      {
        id: 'req-ext-set',
        command: 'config-host-mcp-set',
        args: {
          name: 'vulpine',
          command: 'node',
          args: '["bin/vulpine-mcp.js"]',
          cwd: '/tmp/vulpine',
          'one-cli': 'true',
        },
      },
      { caller: 'host' },
    );
    expect(setResp.ok).toBe(true);

    const getResp = await dispatch(
      {
        id: 'req-ext-get',
        command: 'config-host-mcp-get',
        args: {},
      },
      { caller: 'host' },
    );
    expect(getResp.ok).toBe(true);
    const data = (getResp as { ok: true; data: { host_mcp: { servers: Record<string, { cwd: string }> } } }).data;
    expect(data.host_mcp.servers.vulpine.cwd).toBe('/tmp/vulpine');
  });

  it('lists only agent topic for agent callers', async () => {
    const resp = await dispatch(
      { id: 'req-agent-topics', command: 'config', args: {} },
      {
        caller: 'agent',
        sessionId: 's1',
        agentGroupId: 'g1',
        messagingGroupId: 'mg1',
      },
    );
    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { topics: Array<{ topic: string }> } }).data;
    expect(data.topics.map((t) => t.topic)).toEqual(['agent']);
  });

  it('blocks install-wide config from agent scope', async () => {
    const resp = await dispatch(
      { id: 'req-agent', command: 'config-memory-get', args: {} },
      {
        caller: 'agent',
        sessionId: 's1',
        agentGroupId: 'g1',
        messagingGroupId: 'mg1',
      },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });
});
