import { execFileSync } from 'node:child_process';
import { getLaunchdLabel } from '../src/install-slug.js';
import { writeEnvFile } from '../src/env.js';
import { emitStatus } from './status.js';

/** The adapter is a pinned runtime dependency; setup changes only private credentials. */
export async function run(_args: string[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^[0-9]+:[A-Za-z0-9_-]{35,}$/.test(token)) throw new Error('Provide a valid TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8000) });
  const result = await response.json() as { ok?: boolean; result?: { username?: string } };
  if (!response.ok || !result.ok || !result.result?.username) throw new Error('Telegram did not accept the bot credentials');
  writeEnvFile({ TELEGRAM_BOT_TOKEN: token });
  execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid!()}/${getLaunchdLabel()}`], { stdio: 'pipe' });
  emitStatus('ADD_TELEGRAM', { STATUS: 'success', BOT_USERNAME: result.result.username, ADAPTER_ALREADY_INSTALLED: true });
}
