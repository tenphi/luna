import fs from 'fs';
import path from 'path';

import { SESSIONS_DIR } from './config.js';
import { getAgentDir } from './install-paths.js';
import { ensureAgentContainerFile } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const DEFAULT_SETTINGS_JSON = '{}\n';
const LEGACY_DEFAULT_SUBDIR = 'luna';

function legacyGroupsDir(): string {
  return path.resolve(path.dirname(getAgentDir()), 'groups');
}

/**
 * Migrate legacy `groups/luna/` (or first subdir) to top-level `agent/`.
 * Idempotent — no-op when `agent/` already exists.
 */
export function migrateAgentWorkspace(): void {
  const agentDir = getAgentDir();
  const groupsDir = legacyGroupsDir();
  if (fs.existsSync(agentDir)) return;
  if (!fs.existsSync(groupsDir)) return;

  const legacyDefault = path.join(groupsDir, LEGACY_DEFAULT_SUBDIR);
  let source = legacyDefault;
  if (!fs.existsSync(source)) {
    const subdirs = fs
      .readdirSync(groupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'global')
      .map((e) => e.name);
    if (subdirs.length === 0) return;
    if (subdirs.length > 1) {
      log.warn('Multiple legacy group folders found — migrating first only', { folders: subdirs });
    }
    source = path.join(groupsDir, subdirs[0]!);
  }

  try {
    fs.renameSync(source, agentDir);
    log.info('Migrated legacy agent workspace', { from: source, to: agentDir });
  } catch {
    fs.cpSync(source, agentDir, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
    log.info('Copied legacy agent workspace', { from: source, to: agentDir });
  }

  try {
    const remaining = fs.readdirSync(groupsDir);
    if (remaining.length === 0) {
      fs.rmdirSync(groupsDir);
    }
  } catch {
    /* non-empty or already gone */
  }
}

/**
 * Initialize the on-disk filesystem state for the install agent. Idempotent —
 * every step is gated on the target not already existing.
 *
 * Called once at agent creation, or defensively from `buildMounts()`.
 *
 * The composed `AGENTS.md` is NOT written here — it's regenerated on every
 * spawn by `composeAgentsMd()` (see `agents-md-compose.ts`). Initial
 * per-agent instructions (if provided) seed `AGENTS.local.md`.
 */
export function initAgentFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  migrateAgentWorkspace();
  const initialized: string[] = [];
  const agentDir = getAgentDir();

  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
    initialized.push('agentDir');
  }

  const agentsLocalFile = path.join(agentDir, 'AGENTS.local.md');
  if (!fs.existsSync(agentsLocalFile)) {
    const body = opts?.instructions ? opts.instructions + '\n' : '';
    fs.writeFileSync(agentsLocalFile, body);
    initialized.push('AGENTS.local.md');
  }

  // Writable scan root for agent-authored skills (managed via `manage_skill`).
  // Mounted at /workspace/agent/skills; discovered alongside built-in skills.
  const authoredSkillsDir = path.join(agentDir, 'skills');
  if (!fs.existsSync(authoredSkillsDir)) {
    fs.mkdirSync(authoredSkillsDir, { recursive: true });
    initialized.push('agent/skills');
  }

  if (ensureAgentContainerFile(group)) {
    initialized.push('container.json');
  }

  const agentsDir = path.join(SESSIONS_DIR, group.id, '.agents-shared');
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
    initialized.push('.agents-shared');
  }

  const settingsFile = path.join(agentsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  const skillsDst = path.join(agentsDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
  }

  if (initialized.length > 0) {
    log.info('Initialized agent filesystem', {
      agent: group.name,
      id: group.id,
      steps: initialized,
    });
  }
}
