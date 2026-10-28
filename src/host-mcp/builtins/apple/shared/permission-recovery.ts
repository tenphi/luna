import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getAppBundleExecutable } from './app-bundle.js';
import { isAppEnabled, loadAppleConfig } from './config.js';
import { resolveAppleHealthPath } from './paths.js';
import type { AppleHealth, AppHealth } from './permissions.js';
import type { AppleAppId } from './types.js';

const execFileAsync = promisify(execFile);
const CHECK_INTERVAL_MS = 5_000;

function readHealth(): Partial<AppleHealth> {
  try {
    return JSON.parse(fs.readFileSync(resolveAppleHealthPath(), 'utf8')) as Partial<AppleHealth>;
  } catch (err) {
    // The foreground primer may be replacing the cache as we read it.
    if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function probeInNewBundleProcess(apps: AppleAppId[]): Promise<Partial<AppleHealth>> {
  const script = path.join(process.cwd(), 'dist/host-mcp/builtins/apple/shared/permission-check.js');
  const { stdout } = await execFileAsync(getAppBundleExecutable(process.cwd()), [script, ...apps], {
    timeout: apps.length * 35_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(stdout) as Partial<AppleHealth>;
}

/** Run outside the host's process group so restarting launchd cannot kill the redeploy. */
async function redeployAfterGrant(): Promise<void> {
  const cli = path.join(process.cwd(), 'dist/cli/client.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'redeploy', '--no-build'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Watch only permissions denied at startup. The GUI primer reports approved
 * prompts through health.json; fresh bundle probes also catch grants made
 * directly in System Settings, including Full Disk Access. This does not launch
 * the GUI primer or change permission settings. A grant causes one redeploy
 * of the current build.
 */
export function startApplePermissionRecovery(health: AppleHealth, enabledApps: AppleAppId[]): () => void {
  const denied = enabledApps.filter((app) => health[app]?.status === 'denied');
  if (denied.length === 0) return () => {};

  let stopped = false;
  let checking = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const check = async (): Promise<void> => {
    if (stopped || checking) return;
    checking = true;
    try {
      const config = loadAppleConfig();
      const pending = denied.filter((app) => isAppEnabled(config, app));
      if (pending.length === 0) {
        stop();
        return;
      }

      const fromPrimer = readHealth();
      let granted = pending.filter(
        (app) => fromPrimer[app]?.status === 'ok' && fromPrimer[app]!.checkedAt > health[app].checkedAt,
      );
      if (granted.length === 0) {
        const probed = await probeInNewBundleProcess(pending);
        if (stopped) return;
        // Preserve results written by the primer while this probe was running.
        const latest = readHealth();
        const updates: Partial<AppleHealth> = {};
        for (const app of pending) {
          const result: AppHealth | undefined = probed[app];
          if (result && (!latest[app] || result.checkedAt >= latest[app]!.checkedAt)) updates[app] = result;
        }
        const merged = { ...health, ...latest, ...updates };
        fs.writeFileSync(resolveAppleHealthPath(), JSON.stringify(merged, null, 2) + '\n');
        granted = pending.filter((app) => merged[app]?.status === 'ok');
      }
      if (stopped || granted.length === 0) return;
      // Config can change while a slow probe is waiting on macOS.
      const currentConfig = loadAppleConfig();
      granted = granted.filter((app) => isAppEnabled(currentConfig, app));
      if (granted.length === 0) return;
      console.error(`[apple] permission granted: ${granted.join(', ')}; redeploying the current build.`);
      await redeployAfterGrant();
      stop();
    } catch (err) {
      console.error('[apple] permission recovery check failed:', err instanceof Error ? err.message : err);
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  timer.unref();
  console.error(
    `[apple] waiting for permission grants: ${denied.join(', ')}; grants will redeploy Luna automatically.`,
  );
  return stop;
}
