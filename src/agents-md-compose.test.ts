import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_LOCAL_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  return { TEST_LOCAL_DIR: nodePath.join(nodeOs.tmpdir(), 'luna-agents-md-compose-test') };
});

vi.mock('./config/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/paths.js')>();
  return {
    ...actual,
    configDir: () => TEST_LOCAL_DIR,
    localConfigPath: () => path.join(TEST_LOCAL_DIR, 'local.jsonc'),
  };
});

import { clearConfigCache } from './config/loader.js';
import { writeLocalConfig } from './config/write.js';
import { composeAgentsMd } from './agents-md-compose.js';
import { getAgentDir } from './install-paths.js';
import { writeStoredContainerConfig } from './container-config.js';
import { isAppleBuiltinEnabled } from './host-mcp/builtins/apple/provider.js';
import type { AgentGroup } from './types.js';

const TEST_SKILL = '_compose-test-dual';

const group: AgentGroup = {
  id: 'compose-test',
  name: 'Compose Test',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

const skillDir = path.join(process.cwd(), 'container', 'skills', TEST_SKILL);
const agentDir = getAgentDir();

beforeEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_LOCAL_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_LOCAL_DIR, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'instructions.md'), '# Always-on\n\nUse the dual skill tools.\n');
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: compose-test-dual\ndescription: Full workflow on demand\n---\n\n# Full skill body\n',
  );
  fs.mkdirSync(agentDir, { recursive: true });
  writeStoredContainerConfig({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    cliScope: 'agent',
  });
});

afterEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_LOCAL_DIR, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  const fragments = path.join(agentDir, '.agents-fragments');
  const agentsMd = path.join(agentDir, 'AGENTS.md');
  if (fs.existsSync(fragments)) fs.rmSync(fragments, { recursive: true, force: true });
  if (fs.existsSync(agentsMd)) fs.unlinkSync(agentsMd);
});

describe('composeAgentsMd', () => {
  it('includes instructions.md fragment when SKILL.md also exists', () => {
    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', `skill-${TEST_SKILL}.md`);
    expect(fs.lstatSync(fragmentPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fragmentPath)).toBe(`/app/skills/${TEST_SKILL}/instructions.md`);

    const agentsMd = fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain(`@./.agents-fragments/skill-${TEST_SKILL}.md`);
  });

  it('omits instructions.md for skills listed in skillsDisabled', () => {
    writeStoredContainerConfig({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      skillsDisabled: [TEST_SKILL],
      cliScope: 'agent',
    });

    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', `skill-${TEST_SKILL}.md`);
    expect(fs.existsSync(fragmentPath)).toBe(false);
  });

  it('injects the core memory fragment when memory is enabled', () => {
    writeLocalConfig({ memory: { enabled: true } });
    writeStoredContainerConfig({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      cliScope: 'agent',
    });

    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', 'memory.md');
    expect(fs.lstatSync(fragmentPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fragmentPath)).toBe('/app/container-tree/fragments/memory.md');

    const agentsMd = fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('@./.agents-fragments/memory.md');
    // The import line is agent-visible, so the backend must not be named in it.
    expect(agentsMd).not.toContain('akno');
  });

  it('omits the memory fragment by default', () => {
    composeAgentsMd(group);
    const fragmentPath = path.join(agentDir, '.agents-fragments', 'memory.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);
  });

  // Unconditional: the toolbelt is baked into the base image, so the inventory
  // and the escalation ladder are true for every agent regardless of config.
  it('always injects the tools fragment', () => {
    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', 'tools.md');
    expect(fs.lstatSync(fragmentPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fragmentPath)).toBe('/app/container-tree/fragments/tools.md');
    expect(fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8')).toContain('@./.agents-fragments/tools.md');
  });

  it('keeps the tools fragment even when memory is disabled install-wide', () => {
    fs.writeFileSync(path.join(TEST_LOCAL_DIR, 'local.jsonc'), JSON.stringify({ memory: { enabled: false } }));
    clearConfigCache();

    composeAgentsMd(group);
    // lstat, not existsSync: the symlink target only resolves inside the container.
    expect(fs.lstatSync(path.join(agentDir, '.agents-fragments', 'tools.md')).isSymbolicLink()).toBe(true);
  });

  it('omits the memory fragment when memory is disabled install-wide', () => {
    fs.writeFileSync(path.join(TEST_LOCAL_DIR, 'local.jsonc'), JSON.stringify({ memory: { enabled: false } }));
    clearConfigCache();

    composeAgentsMd(group);
    const fragmentPath = path.join(agentDir, '.agents-fragments', 'memory.md');
    expect(fs.existsSync(fragmentPath)).toBe(false);
  });

  // The reminders fragment is what stops `schedule_task` from being used as the
  // owner's to-do list — but only where the reminders tools exist, so it tracks
  // whether the builtin is actually wired rather than shipping unconditionally.
  it('injects the reminders fragment exactly when apple_reminders is wired', () => {
    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', 'reminders.md');
    if (isAppleBuiltinEnabled()) {
      expect(fs.lstatSync(fragmentPath).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fragmentPath)).toBe('/app/container-tree/fragments/reminders.md');
      expect(fs.readFileSync(path.join(agentDir, 'AGENTS.md'), 'utf-8')).toContain('@./.agents-fragments/reminders.md');
    } else {
      expect(fs.existsSync(fragmentPath)).toBe(false);
    }
  });

  it('omits the reminders fragment when the apple_reminders relay is kill-switched', () => {
    writeStoredContainerConfig({
      mcpServers: { apple_reminders: { env: { MCP_DISABLE: 'true' } } },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      cliScope: 'agent',
    });

    composeAgentsMd(group);

    expect(fs.existsSync(path.join(agentDir, '.agents-fragments', 'reminders.md'))).toBe(false);
  });

  it('omits the reminders fragment when apple is disabled install-wide', () => {
    fs.writeFileSync(path.join(TEST_LOCAL_DIR, 'local.jsonc'), JSON.stringify({ apple: { enabled: false } }));
    clearConfigCache();

    composeAgentsMd(group);

    expect(fs.existsSync(path.join(agentDir, '.agents-fragments', 'reminders.md'))).toBe(false);
  });

  it('includes skill when listed in an explicit skills array', () => {
    writeStoredContainerConfig({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [TEST_SKILL],
      cliScope: 'agent',
    });

    composeAgentsMd(group);

    const fragmentPath = path.join(agentDir, '.agents-fragments', `skill-${TEST_SKILL}.md`);
    expect(fs.lstatSync(fragmentPath).isSymbolicLink()).toBe(true);
  });
});
