import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getAgentDir } from './install-paths.js';
import { localConfigExists } from './config/write.js';
import { agentConfigPath } from './container-config.js';
import { closeDb, createAgentGroup, getDb, initTestDb, initializeCentralSchema } from './db/index.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { DEFAULT_GROUP_ID, ensureCliWiring, getTheAgent } from './bootstrap.js';

beforeEach(() => {
  initTestDb();
  initializeCentralSchema(getDb());
});

afterEach(() => {
  closeDb();
});

describe('bootstrap', () => {
  it('getTheAgent creates luna-default on empty DB', () => {
    const ag = getTheAgent();
    expect(ag.id).toBe(DEFAULT_GROUP_ID);
    expect(localConfigExists() || fs.existsSync(agentConfigPath())).toBe(true);
  });

  it('ensureCliWiring wires cli/local to the agent', () => {
    ensureCliWiring();
    const ag = getTheAgent();
    const mg = getMessagingGroupByPlatform('cli', 'local');
    expect(mg).toBeDefined();
    expect(getMessagingGroupAgentByPair(mg!.id, ag.id)).toBeDefined();
  });

  describe('createDefaultAgentGroup preserve', () => {
    const agentConfigFile = path.join(getAgentDir(), 'container.json');
    let backupAgentConfig: string | undefined;

    beforeEach(() => {
      if (fs.existsSync(agentConfigFile)) {
        backupAgentConfig = fs.readFileSync(agentConfigFile, 'utf-8');
      }
    });

    afterEach(() => {
      if (backupAgentConfig !== undefined) {
        fs.mkdirSync(path.dirname(agentConfigFile), { recursive: true });
        fs.writeFileSync(agentConfigFile, backupAgentConfig);
      } else if (fs.existsSync(agentConfigFile)) {
        fs.unlinkSync(agentConfigFile);
      }
      backupAgentConfig = undefined;
    });

    it('does not replace mcpServers when container.json already exists', () => {
      fs.mkdirSync(path.dirname(agentConfigFile), { recursive: true });
      fs.writeFileSync(
        agentConfigFile,
        JSON.stringify(
          {
            mcpServers: { kept: { command: 'noop' } },
            packages: { apt: [], npm: [] },
            skills: 'all',
          },
          null,
          2,
        ) + '\n',
      );

      getTheAgent();

      const stored = JSON.parse(fs.readFileSync(agentConfigFile, 'utf-8')) as {
        mcpServers: Record<string, { command?: string }>;
      };
      expect(stored.mcpServers.kept?.command).toBe('noop');
    });
  });

  it('getTheAgent throws when multiple agent groups exist', () => {
    const now = new Date().toISOString();
    getTheAgent();
    createAgentGroup({
      id: 'ag-extra',
      name: 'Extra',
      agent_provider: null,
      created_at: now,
    });
    expect(() => getTheAgent()).toThrow(/Multiple agent groups/);
  });
});
