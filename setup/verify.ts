import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, getMountAllowlistPath } from '../src/config.js';
import { loadLunaConfig, resolveOpenAiProviderConfig } from '../src/config/loader.js';
import { readEnvFile } from '../src/env.js';
import { getLaunchdLabel } from '../src/install-slug.js';
import { emitStatus } from './status.js';

type ServiceState = 'not_found' | 'stopped' | 'running' | 'running_other_checkout';

function serviceState(root: string): ServiceState {
  try {
    const output = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' });
    const fields = output
      .split('\n')
      .map((row) => row.trim().split(/\s+/))
      .find((row) => row.at(-1) === getLaunchdLabel(root));
    if (!fields) return 'not_found';
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid) || pid < 1) return 'stopped';
    try {
      const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (command.includes(path.join(root, 'dist', 'index.js'))) return 'running';
      if (/\bdist\/index\.js\b/.test(command)) return 'running_other_checkout';
    } catch {
      /* A valid launchd PID still establishes service health. */
    }
    return 'running';
  } catch {
    return 'not_found';
  }
}

function wiredAgents(): number {
  const file = path.join(DATA_DIR, 'luna.db');
  if (!fs.existsSync(file)) return 0;
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.prepare('SELECT COUNT(DISTINCT agent_group_id) AS total FROM messaging_group_agents').get() as {
        total: number;
      }
    ).total;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

export function determineVerifyStatus(input: {
  service: ServiceState;
  credentials: string;
  registeredGroups: number;
}): 'success' | 'failed' {
  const ready = input.service === 'running' && input.registeredGroups > 0 && input.credentials !== 'missing';
  return ready ? 'success' : 'failed';
}

export async function run(_args: string[]): Promise<void> {
  const service = serviceState(process.cwd());
  let container = 'none';
  try {
    execFileSync('container', ['system', 'status'], { stdio: 'ignore' });
    container = 'container';
  } catch {
    /* Report an unavailable runtime. */
  }
  const endpoint = resolveOpenAiProviderConfig();
  const credentials =
    endpoint.apiKey ||
    (endpoint.baseUrl && new URL(endpoint.baseUrl).hostname !== 'api.openai.com') ||
    loadLunaConfig().install?.onecli?.url
      ? 'configured'
      : 'missing';
  const telegram = process.env.TELEGRAM_BOT_TOKEN || readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
  const channels = telegram ? { telegram: 'configured' } : {};
  const groups = wiredAgents();
  const status = determineVerifyStatus({ service, credentials, registeredGroups: groups });
  emitStatus('VERIFY', {
    SERVICE: service,
    CONTAINER_RUNTIME: container,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: Object.keys(channels).join(','),
    CHANNEL_AUTH: JSON.stringify(channels),
    REGISTERED_GROUPS: groups,
    MOUNT_ALLOWLIST: fs.existsSync(getMountAllowlistPath()) ? 'configured' : 'missing',
    STATUS: status,
    LOG: 'logs/setup.log',
  });
  if (status === 'failed') process.exit(1);
}
