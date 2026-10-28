import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { persistOnecliApiKey, persistOnecliUrl } from '../src/config/setup-persist.js';
import { DEFAULT_ONECLI_URL, ensureOneCliRuntime, pollOneCliHealth } from '../src/onecli-runtime.js';
import { log } from '../src/log.js';
import { optionValue } from './lib/arguments.js';
import { emitStatus } from './status.js';
export { pollOneCliHealth as pollHealth };

const environment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [path.join(os.homedir(), '.local', 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
});
function cli(args: string[]): string {
  return execFileSync('onecli', args, {
    env: environment(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function version(): string | undefined {
  try {
    return cli(['version']) || undefined;
  } catch {
    return;
  }
}
export function getOnecliApiHost(): string | null {
  try {
    const text = cli(['config', 'get', 'api-host']);
    let value: unknown;
    try {
      const parsed = JSON.parse(text);
      value = parsed.data ?? parsed.value;
    } catch {
      /* Plain CLI output also occurs. */
    }
    if (typeof value !== 'string') value = text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
    return typeof value === 'string' && ['http:', 'https:'].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}
function ensureCli(): void {
  if (version()) return;
  // Official standalone CLI installer; its implementation stays outside Luna's source tree.
  const installer = execFileSync(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      'https://onecli.sh/cli/install',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  execFileSync('/bin/sh', [], { input: installer, env: environment(), stdio: ['pipe', 'inherit', 'inherit'] });
  if (!version()) throw new Error('The OneCLI installer completed without an available CLI');
}
function setEndpoint(url: string): void {
  try {
    cli(['config', 'set', 'api-host', url]);
  } catch {
    throw new Error('Could not save the OneCLI CLI endpoint');
  }
  persistOnecliUrl(url);
}
export async function run(args: string[]): Promise<void> {
  try {
    const remote = optionValue(args, '--remote-url');
    if (remote) {
      const parsed = new URL(remote);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('OneCLI requires an HTTP(S) URL without embedded credentials');
    }
    if (args.includes('--reuse')) {
      if (!version()) throw new Error('Install OneCLI before choosing reuse');
    } else ensureCli();
    const reused = args.includes('--reuse');
    const runtime = !remote && !reused ? await ensureOneCliRuntime() : undefined;
    const url = remote ?? runtime?.url ?? getOnecliApiHost() ?? DEFAULT_ONECLI_URL;
    setEndpoint(url);
    const token = remote ? process.env.LUNA_ONECLI_API_TOKEN?.trim() : undefined;
    if (token) {
      try {
        cli(['auth', 'login', '--api-key', token]);
      } catch {
        throw new Error('OneCLI rejected the access token');
      }
      persistOnecliApiKey(token);
    }
    const healthy = runtime?.healthy ?? (await pollOneCliHealth(url, 5000));
    emitStatus('ONECLI', {
      STATUS: 'success',
      INSTALLED: true,
      REMOTE: Boolean(remote),
      REUSED: reused,
      ONECLI_URL: url,
      HEALTHY: healthy,
      ...(healthy
        ? {}
        : { HEALTH_HINT: 'The gateway has not reported ready; complete authentication and retry verification.' }),
    });
  } catch (error) {
    // Command failures may contain credentials in their argv; keep those out of output and logs.
    log.error('OneCLI setup failed');
    emitStatus('ONECLI', {
      STATUS: 'failed',
      INSTALLED: false,
      ERROR: 'onecli_setup_failed',
      HINT: error instanceof Error && !('cmd' in error) ? error.message : 'Install the OneCLI CLI and retry setup.',
    });
    process.exitCode = 1;
  }
}
