/**
 * Step: tavily — configure the Tavily web-search API key.
 *
 * `tavily-mcp` is baked into the agent image and the host forwards
 * `TAVILY_API_KEY` into every container. Once the key is in `.env`, the MCP
 * server is auto-wired at spawn (see src/tavily-defaults.ts) and the agent
 * gets `mcp__tavily__*` tools — so web-search works instead of the browser.
 *
 * Usage:
 *   pnpm exec tsx setup/index.ts --step tavily                 # interactive (TTY)
 *   pnpm exec tsx setup/index.ts --step tavily -- --key tvly-… # non-interactive
 *   pnpm exec tsx setup/index.ts --step tavily -- --check      # report status only
 *
 * The key goes to `.env` only — never into config/local.jsonc, container.json,
 * or process command lines.
 */
import * as p from '@clack/prompts';

import { readEnvFile, writeEnvFile } from '../src/env.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

function currentKey(): string | null {
  return readEnvFile(['TAVILY_API_KEY']).TAVILY_API_KEY ?? null;
}

function persist(key: string): void {
  writeEnvFile({ TAVILY_API_KEY: key });
  log.info('Updated .env', { key: 'TAVILY_API_KEY', existed: true });
}

export async function run(args: string[]): Promise<void> {
  const keyIdx = args.indexOf('--key');
  const flagValue = keyIdx !== -1 ? args[keyIdx + 1]?.trim() : undefined;
  const checkOnly = args.includes('--check');

  // Non-interactive: explicit key wins.
  if (flagValue) {
    persist(flagValue);
    emitStatus('TAVILY', { STATUS: 'success', KEY: 'set' });
    return;
  }

  const existing = currentKey();

  if (checkOnly) {
    emitStatus('TAVILY', { STATUS: existing ? 'success' : 'missing', KEY: existing ? 'set' : 'unset' });
    return;
  }

  const canPrompt = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!canPrompt) {
    // No key, no TTY — report status without failing so `setup apply` stays
    // non-fatal for installs that don't use Tavily.
    emitStatus('TAVILY', { STATUS: existing ? 'success' : 'skipped', KEY: existing ? 'set' : 'unset' });
    return;
  }

  const answer = await p.password({
    message: existing
      ? 'Tavily API key (leave blank to keep the current one)'
      : 'Tavily API key (from app.tavily.com — leave blank to skip)',
  });

  if (p.isCancel(answer)) {
    emitStatus('TAVILY', { STATUS: 'skipped', KEY: existing ? 'set' : 'unset' });
    return;
  }

  const value = (answer ?? '').trim();
  if (!value) {
    emitStatus('TAVILY', { STATUS: existing ? 'success' : 'skipped', KEY: existing ? 'set' : 'unset' });
    return;
  }

  persist(value);
  p.log.success('Tavily key saved. Web search is wired — run `luna restart` to pick it up.');
  emitStatus('TAVILY', { STATUS: 'success', KEY: 'set' });
}
