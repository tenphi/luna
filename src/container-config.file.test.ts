import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_LOCAL_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  return { TEST_LOCAL_DIR: nodePath.join(nodeOs.tmpdir(), 'luna-container-config-file-test') };
});

vi.mock('./config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/paths.js')>();
  return {
    ...actual,
    configDir: () => TEST_LOCAL_DIR,
    localConfigPath: () => path.join(TEST_LOCAL_DIR, 'local.jsonc'),
  };
});

vi.mock('./db/install-settings.js', () => ({
  getMcpToolFilters: () => ({}),
}));

vi.mock('./host-mcp/defaults.js', () => ({
  mergeHostMcpRelays: (servers: Record<string, unknown>) => servers,
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (id: string) =>
    id === 'luna-default'
      ? {
          id: 'luna-default',
          name: 'Luna',
          agent_provider: null,
          created_at: new Date().toISOString(),
        }
      : null,
}));

import { getAgentDir } from './install-paths.js';
import { localConfigPath } from './config/paths.js';
import { clearConfigCache, loadLunaConfig } from './config/loader.js';
import { initAgentFilesystem } from './agent-init.js';
import {
  defaultStoredContainerConfig,
  enrichForRuntime,
  loadContainerConfig,
  normalizeStoredContainerConfig,
  omitHostMcpServers,
  readStoredContainerConfig,
  sanitizeMcpServerForStorage,
  writeStoredContainerConfig,
} from './container-config.js';
import { DEFAULT_SKILLS_DISABLED } from './container-skills.js';
import type { AgentGroup } from './types.js';

const group: AgentGroup = {
  id: 'luna-default',
  name: 'Luna',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

function localPath(): string {
  return localConfigPath();
}

const legacyConfigPath = () => path.join(getAgentDir(), 'container.json');
const testLegacyBackup = `${legacyConfigPath()}.test-backup`;

beforeEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_LOCAL_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_LOCAL_DIR, { recursive: true });
  const legacy = legacyConfigPath();
  if (fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, testLegacyBackup);
    fs.unlinkSync(legacy);
  }
});

afterEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_LOCAL_DIR, { recursive: true, force: true });
  const legacy = legacyConfigPath();
  if (fs.existsSync(testLegacyBackup)) {
    fs.copyFileSync(testLegacyBackup, legacy);
    fs.unlinkSync(testLegacyBackup);
  } else if (fs.existsSync(legacy)) {
    fs.unlinkSync(legacy);
  }
});

describe('stored container config file', () => {
  it('preserves either topic classifier through stored/runtime config normalization', () => {
    for (const classifier of ['decisions', 'model'] as const) {
      const stored = normalizeStoredContainerConfig({ context: { topics: { classifier } } });
      expect(stored.context?.topics?.classifier).toBe(classifier);
      expect(enrichForRuntime(stored, group).context?.topics?.classifier).toBe(classifier);
    }
    expect(
      normalizeStoredContainerConfig({ context: { topics: { classifier: 'invalid' } } }).context?.topics?.classifier,
    ).toBeUndefined();
  });

  it('defaultStoredContainerConfig includes default skillsDisabled', () => {
    const stored = defaultStoredContainerConfig(group);
    expect(stored.skillsDisabled).toEqual([...DEFAULT_SKILLS_DISABLED]);
  });

  it('readStoredContainerConfig leaves skillsDisabled unset when defaults are empty', () => {
    writeStoredContainerConfig({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      skills: 'all',
      additionalMounts: [],
    });
    clearConfigCache();
    const stored = readStoredContainerConfig(group);
    expect(stored.skillsDisabled).toBeUndefined();
  });

  it('round-trips read/write including MCP tool filters', () => {
    writeStoredContainerConfig({
      mcpServers: {
        tavily: { command: 'tavily-mcp', args: [], env: {} },
        notes: { toolsAllow: ['search'] },
      },
      packages: { apt: ['curl'], npm: [] },
      additionalMounts: [],
      skills: 'all',
      provider: 'openai',
      model: 'test-model',
      cliScope: 'global',
    });
    clearConfigCache();

    const stored = readStoredContainerConfig(group);
    expect(stored.model).toBe('test-model');
    expect(stored.packages.apt).toEqual(['curl']);
    expect(stored.mcpServers.tavily?.command).toBe('tavily-mcp');
    expect(stored.mcpServers.notes?.toolsAllow).toEqual(['search']);
  });

  it('preserves toolsAllow from file on read', () => {
    writeStoredContainerConfig({
      mcpServers: {
        custom: { command: 'custom-mcp', toolsAllow: ['search'] },
      },
      packages: { apt: [], npm: [] },
      skills: 'all',
      additionalMounts: [],
    });
    clearConfigCache();

    const stored = readStoredContainerConfig(group);
    expect(stored.mcpServers.custom?.command).toBe('custom-mcp');
    expect(stored.mcpServers.custom?.toolsAllow).toEqual(['search']);
  });

  // Removed: Memory is a host MCP builtin now, injected as a relay rather than merged in as a command, and it carries no model env — those are the memory service's own config.

  it('enrichForRuntime omits host MCP servers from runtime config', () => {
    const stored: Parameters<typeof enrichForRuntime>[0] = {
      mcpServers: {
        tavily: { command: 'tavily-mcp', args: [] },
        vulpine: { host: true, toolsAllow: ['summary'] },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    };
    const runtime = enrichForRuntime(stored, group);
    expect(runtime.mcpServers.tavily?.command).toBe('tavily-mcp');
    expect(runtime.mcpServers.vulpine).toBeUndefined();
  });

  it('enrichForRuntime copies apple default calendar and reminders list', () => {
    fs.writeFileSync(
      localPath(),
      JSON.stringify({
        apple: {
          apps: {
            calendar: { defaultCalendar: 'Household' },
            reminders: { defaultList: 'Household' },
          },
        },
      }),
    );
    clearConfigCache();

    const runtime = enrichForRuntime(defaultStoredContainerConfig(group), group);
    expect(runtime.apple).toEqual({
      defaultCalendar: 'Household',
      defaultRemindersList: 'Household',
    });
    expect(runtime.memory).toEqual({ autoRecall: false });
  });

  it('enrichForRuntime passes the install-wide auto-recall preference', () => {
    fs.writeFileSync(localPath(), JSON.stringify({ memory: { enabled: true, autoRecall: false } }));
    clearConfigCache();

    const runtime = enrichForRuntime(defaultStoredContainerConfig(group), group);
    expect(runtime.memory).toEqual({ autoRecall: false });
  });

  it('sanitizeMcpServerForStorage strips command from host entries', () => {
    expect(
      sanitizeMcpServerForStorage({
        host: true,
        command: 'node',
        toolsAllow: ['summary'],
      }),
    ).toEqual({ host: true, toolsAllow: ['summary'] });
  });

  it('omitHostMcpServers removes only host entries', () => {
    const out = omitHostMcpServers({
      a: { command: 'x' },
      b: { host: true, toolsAllow: ['t'] },
    });
    expect(out.a?.command).toBe('x');
    expect(out.b).toBeUndefined();
  });

  it('initAgentFilesystem does not rewrite existing local config', () => {
    writeStoredContainerConfig({
      mcpServers: { vulpine: { host: true, toolsAllow: ['summary'] } },
      packages: { apt: [], npm: [] },
      skills: 'all',
      additionalMounts: [],
    });
    clearConfigCache();
    const content = fs.readFileSync(localPath(), 'utf-8');
    initAgentFilesystem(group);
    expect(fs.readFileSync(localPath(), 'utf-8')).toBe(content);
  });

  it('initAgentFilesystem creates the agent/skills scan root', () => {
    initAgentFilesystem(group);
    expect(fs.existsSync(path.join(getAgentDir(), 'skills'))).toBe(true);
  });

  it('normalizeStoredContainerConfig accepts snake_case legacy keys', () => {
    const stored = normalizeStoredContainerConfig({
      mcp_servers: { tavily: { command: 'tavily-mcp' } },
      packages_apt: ['jq'],
      cli_scope: 'global',
      assistant_name: 'Luna',
    } as Record<string, unknown>);
    expect(stored.cliScope).toBe('global');
    expect(stored.assistantName).toBe('Luna');
    expect(stored.mcpServers.tavily?.command).toBe('tavily-mcp');
  });

  it('normalizeStoredContainerConfig maps legacy group cli_scope to agent', () => {
    const stored = normalizeStoredContainerConfig({ cli_scope: 'group' } as Record<string, unknown>);
    expect(stored.cliScope).toBe('agent');
  });

  it('loadContainerConfig re-reads local.jsonc after manual edits (stale cache)', () => {
    writeStoredContainerConfig({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });
    clearConfigCache();

    // Seed cache with old embedding settings.
    fs.writeFileSync(
      localPath(),
      JSON.stringify(
        {
          models: { main: { id: 'old-chat', provider: 'openai' } },
        },
        null,
        2,
      ) + '\n',
    );
    expect(loadLunaConfig().models?.main?.id).toBe('old-chat');

    // Manual edit of local.jsonc does not call clearConfigCache (unlike writeLocalConfig).
    fs.writeFileSync(
      localPath(),
      JSON.stringify(
        {
          models: { main: { id: 'new-chat', provider: 'lmstudio' } },
        },
        null,
        2,
      ) + '\n',
    );
    // Cache still holds the old value until spawn reload.
    expect(loadLunaConfig().models?.main?.id).toBe('old-chat');

    // Spawn re-reads: the point of the test. Asserted on the config itself rather than on a value
    // carried into an MCP server's env, because no MCP server carries model config any more —
    // memory's models are memory's own config.
    loadContainerConfig('luna-default');
    expect(loadLunaConfig().models?.main?.id).toBe('new-chat');
    expect(loadLunaConfig().models?.main?.provider).toBe('lmstudio');
  });
});
