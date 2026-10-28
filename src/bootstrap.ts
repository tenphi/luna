/**
 * Install bootstrap — single-agent setup for personal Luna installs.
 */
import { createAgentGroup, getAllAgentGroups } from './db/agent-groups.js';
import { connectChannel } from './channel-wiring.js';
import { agentConfigPath, ensureAgentContainerFile, updateStoredContainerConfig } from './container-config.js';
import { localConfigExists } from './config/write.js';
import { configLayerErrors, loadLunaConfig, resolveInstallDefaults } from './config/loader.js';
import { validateRoster } from './users/roster.js';
import { resolveAssistantName } from './config/unified-agent.js';
import { initAgentFilesystem, migrateAgentWorkspace } from './agent-init.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';
import fs from 'fs';

export const DEFAULT_GROUP_ID = 'luna-default';

export interface BootstrapPersonaOptions {
  displayName?: string;
  agentName?: string;
  instructions?: string;
}

export function buildDefaultLocalInstructions(displayName: string): string {
  return `# Owner agent

Helping **${displayName}** with daily tasks. Add household members, timezone, and pointers to the memory pages that matter below.

## Household

- **${displayName}:** (add memory page slugs and facts here)
`;
}

function resolveDefaultAgentName(opts?: BootstrapPersonaOptions): string {
  return opts?.agentName?.trim() || resolveAssistantName(loadLunaConfig()) || 'Luna';
}

function createDefaultAgentGroup(now: string, opts?: BootstrapPersonaOptions): AgentGroup {
  const name = resolveDefaultAgentName(opts);
  const group: AgentGroup = {
    id: DEFAULT_GROUP_ID,
    name,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(group);

  const instructions =
    opts?.instructions ?? (opts?.displayName ? buildDefaultLocalInstructions(opts.displayName) : undefined);
  const hadContainerConfig = fs.existsSync(agentConfigPath()) || localConfigExists();
  initAgentFilesystem(group, instructions ? { instructions } : undefined);

  const { provider: defaultProvider, model: defaultModel } = resolveInstallDefaults();

  if (!hadContainerConfig) {
    updateStoredContainerConfig(group.id, {
      assistantName: name,
      ...(defaultProvider ? { provider: defaultProvider } : {}),
      ...(defaultModel ? { model: defaultModel } : {}),
    });
  }

  return group;
}

/**
 * Return the single install agent. Creates `luna-default` / `agent/` on a fresh DB.
 * Throws if more than one agent_groups row exists (run `luna db-reset --confirm true`).
 */
export function getTheAgent(opts?: BootstrapPersonaOptions): AgentGroup {
  migrateAgentWorkspace();

  const existing = getAllAgentGroups();
  if (existing.length > 1) {
    throw new Error(
      `Multiple agent groups found (${existing.map((g) => g.id).join(', ')}). ` +
        'Luna is single-agent — run `luna db-reset --confirm true` and restart.',
    );
  }

  if (existing.length === 1) {
    const ag = existing[0]!;
    if (ag.id !== DEFAULT_GROUP_ID) {
      log.warn('Single non-default agent group in use', { id: ag.id });
    }
    ensureAgentContainerFile(ag);
    if (opts?.agentName) {
      updateStoredContainerConfig(ag.id, { assistantName: opts.agentName });
    }
    return ag;
  }

  const now = new Date().toISOString();
  const group = createDefaultAgentGroup(now, opts);
  log.info('Created default agent', { id: group.id });
  return group;
}

/** Idempotent CLI channel wiring to the install agent. */
export function ensureCliWiring(): void {
  connectChannel({ agentId: getTheAgent().id, channel: 'cli', address: 'local', name: 'Local CLI', isGroup: false });
}

/**
 * Complain loudly about a roster that will not work, without refusing to start.
 *
 * Starting anyway is deliberate: a broken roster is fixed from the terminal, and `cli:local` keeps
 * working regardless, so refusing to boot would take away the tool needed to repair the thing that is
 * broken. But it must not be quiet — a config naming nobody, or an owner pointing at a key that does
 * not exist, looks exactly like a correct empty install from the outside.
 */
function reportRosterProblems(): void {
  for (const err of configLayerErrors()) {
    log.error('Config layer could not be parsed — running without it', { path: err.path, detail: err.message });
  }
  for (const err of validateRoster()) {
    log.error('Roster problem in config/local.jsonc', { user: err.key, detail: err.message });
  }
}

/** Host startup: ensure the agent exists and CLI is wired. */
export function bootstrapSingleAgent(): AgentGroup {
  const ag = getTheAgent();
  ensureCliWiring();
  reportRosterProblems();
  if (!fs.existsSync(agentConfigPath()) && !localConfigExists()) {
    throw new Error(`Missing agent config for ${ag.id} — create config/local.jsonc or ${agentConfigPath()}`);
  }
  return ag;
}

/** Setup helper — create/update persona and wire CLI (replaces init-cli-agent.ts). */
export function bootstrapCliAgent(opts: BootstrapPersonaOptions & { displayName: string }): AgentGroup {
  const agentName = resolveDefaultAgentName(opts);
  const localInstructions = opts.instructions ?? buildDefaultLocalInstructions(opts.displayName);
  const ag = getTheAgent({
    displayName: opts.displayName,
    agentName,
    instructions: localInstructions,
  });
  initAgentFilesystem(ag, { instructions: localInstructions });
  updateStoredContainerConfig(ag.id, { assistantName: agentName });
  ensureCliWiring();
  return ag;
}
