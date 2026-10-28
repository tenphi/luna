/**
 * Step: apple — Verify the vendored calendar-helper + macOS permissions.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { seedAppleConfigIfMissing } from '../src/host-mcp/builtins/apple/shared/config.js';
import { APPLE_APP_ORDER } from '../src/host-mcp/builtins/apple/shared/types.js';
import { resolveNativeCalendarHelper } from '../src/host-mcp/builtins/apple/shared/paths.js';
import { runPermissionDryRun } from '../src/host-mcp/builtins/apple/shared/permissions.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  if (os.platform() !== 'darwin') {
    console.log('Apple apps builtin is macOS-only — skipping.');
    emitStatus('APPLE', { STATUS: 'skipped', REASON: 'not-macos' });
    return;
  }

  const helper = resolveNativeCalendarHelper();
  if (!fs.existsSync(helper)) {
    console.log('Vendored calendar-helper missing — building from Swift source…');
    const script = path.resolve(process.cwd(), 'scripts', 'build-calendar-helper.sh');
    try {
      execFileSync('bash', [script], { stdio: 'inherit' });
    } catch (err) {
      const msg = `calendar-helper build failed: ${err instanceof Error ? err.message : String(err)}`;
      emitStatus('APPLE', { STATUS: 'failed', ERROR: msg });
      throw new Error(msg);
    }
  }
  if (!fs.existsSync(helper)) {
    const msg = `calendar-helper missing at ${helper}`;
    emitStatus('APPLE', { STATUS: 'failed', ERROR: msg });
    throw new Error(msg);
  }
  console.log(`  calendar-helper: ${helper}`);

  const config = seedAppleConfigIfMissing();
  console.log(
    `Apple config ready (messages=${config.apps.messages.enabled}, contacts=${config.apps.contacts.enabled})`,
  );

  const health = await runPermissionDryRun(APPLE_APP_ORDER, new Set());
  for (const app of APPLE_APP_ORDER) {
    const h = health[app];
    console.log(`  ${app}: [${h.status}] ${h.message.split('\n')[0]}`);
  }

  const denied = APPLE_APP_ORDER.filter((a) => health[a].status === 'denied');
  if (denied.length > 0) {
    // macOS attributes EventKit and Automation grants to the stable Luna app, so prompt from it.
    console.log(`\nInstalling the Luna app so macOS can ask for access to: ${denied.join(', ')}…`);
    const wrapper = spawnSync('pnpm', ['exec', 'tsx', 'scripts/apple-install-app-wrapper.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    if (wrapper.status !== 0) {
      const msg = 'Could not install the Luna app; run `luna setup` first, then retry `luna setup step apple`.';
      emitStatus('APPLE', { STATUS: 'failed', ERROR: msg });
      throw new Error(msg);
    }
    console.log(`
Enable Messages if needed:
  luna config apple set --messages-enabled true
Verify: luna config apple
`);
  }

  log.info('Apple setup complete');
  emitStatus('APPLE', { STATUS: 'success', PACKAGES: APPLE_APP_ORDER.join(',') });
}
