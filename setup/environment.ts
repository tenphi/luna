import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getCentralDbPath } from '../src/data-paths.js';
import { readEnvFile } from '../src/env.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

export function readEnvKey(key: string, root = process.cwd()): string | null {
  try { return readEnvFile([key], root)[key] ?? null; } catch { return null; }
}
export function detectRegisteredGroups(root: string): boolean {
  const filename = getCentralDbPath(path.join(root, 'data'));
  if (!fs.existsSync(filename)) return false;
  const database = new Database(filename, { readonly: true });
  try {
    const result = database.prepare('SELECT EXISTS(SELECT 1 FROM messaging_group_agents JOIN agent_groups ON agent_groups.id=agent_group_id) AS wired').get() as { wired: number };
    return result.wired === 1;
  } catch { return false; } finally { database.close(); }
}
export async function run(_args: string[]): Promise<void> {
  const platform = getPlatform();
  let runtime = 'not_found';
  if (commandExists('container')) {
    runtime = 'installed_not_running';
    try { execFileSync('container', ['system', 'status'], { stdio: 'ignore' }); runtime = 'running'; } catch { /* Setup can start the installed runtime later. */ }
  }
  const supported = platform === 'macos' && process.arch === 'arm64';
  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform, NODE_VERSION: process.versions.node, CONTAINER_RUNTIME: runtime,
    HAS_ENV: fs.existsSync(path.resolve('.env')), HAS_REGISTERED_GROUPS: detectRegisteredGroups(process.cwd()),
    STATUS: supported ? 'success' : 'failed', LOG: 'logs/setup.log',
  });
  if (!supported) throw new Error('Luna needs an Apple silicon Mac');
}
