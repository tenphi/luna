import fs from 'fs';
import os from 'os';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { readEnvFile } from '../../../env.js';
import { onShutdown } from '../../../response-registry.js';
import { getServiceInfo } from '../../../service/host-service.js';
import type { BuiltinMcpProvider, BuiltinServerInfo } from '../types.js';
import { APPLE_SERVER_KEYS, isAppEnabled, isAppleEnabledInstallWide, loadAppleConfig } from './shared/config.js';
import { APPLE_APP_ORDER } from './shared/types.js';
import { promptApplePermissionsOnStart } from './shared/authorize-on-start.js';
import { runPermissionDryRun } from './shared/permissions.js';
import { ensureCalendarHelperEmbedded } from './shared/app-bundle.js';
import { resolveCalendarHelper } from './shared/paths.js';
import { isLaunchdLikeSession } from './shared/launch-context.js';
import { startApplePermissionRecovery } from './shared/permission-recovery.js';
import { createAppleServer } from './servers/index.js';

function envKillSwitch(): boolean {
  const fromProcess = process.env.LUNA_APPLE_ENABLED;
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess === 'false';
  return readEnvFile(['LUNA_APPLE_ENABLED']).LUNA_APPLE_ENABLED === 'false';
}

export function isAppleBuiltinEnabled(): boolean {
  if (os.platform() !== 'darwin') return false;
  if (envKillSwitch()) return false;
  if (!isAppleEnabledInstallWide()) return false;
  const config = loadAppleConfig();
  return config.enabled;
}

export const appleProvider: BuiltinMcpProvider = {
  id: 'apple',

  isEnabled: isAppleBuiltinEnabled,

  listServers(): BuiltinServerInfo[] {
    if (!isAppleBuiltinEnabled()) return [];
    const config = loadAppleConfig();
    const out: BuiltinServerInfo[] = [];
    for (const app of APPLE_APP_ORDER) {
      if (!isAppEnabled(config, app)) continue;
      out.push({ name: APPLE_SERVER_KEYS[app], oneCli: false });
    }
    return out;
  },

  async prepare() {
    // Keep the calendar-helper copy inside the Luna .app bundle fresh so EventKit
    // TCC attributes to the stable bundle identity. Do NOT call ensureAppBundle
    // here — rewriting the running Mach-O launcher crash-loops launchd.
    try {
      ensureCalendarHelperEmbedded(process.cwd());
    } catch (err) {
      console.error('[apple] ensureCalendarHelperEmbedded failed:', err instanceof Error ? err.message : err);
    }

    const config = loadAppleConfig();
    const enabledApps = APPLE_APP_ORDER.filter((app) => isAppEnabled(config, app));
    const disabledApps = new Set(APPLE_APP_ORDER.filter((app) => !isAppEnabled(config, app)));

    const health = await runPermissionDryRun(APPLE_APP_ORDER, disabledApps);
    for (const app of APPLE_APP_ORDER) {
      const h = health[app];
      if (h.status === 'ok') {
        console.error(`[apple] ${app}: ${h.message}`);
      } else {
        const shortMsg = h.message.split('\n\n')[0]?.trim() ?? h.message;
        console.error(`[apple] ${app}: [${h.status}] ${shortMsg}`);
      }
    }
    promptApplePermissionsOnStart(health, enabledApps);
    if (isLaunchdLikeSession() && getServiceInfo().pid === process.ppid) {
      onShutdown(startApplePermissionRecovery(health, enabledApps));
    }

    const factories: Record<string, () => McpServer> = {};
    const disabledServerNames = new Set<string>();

    for (const app of enabledApps) {
      const serverName = APPLE_SERVER_KEYS[app];

      // Calendar + Reminders need the vendored EventKit helper binary present.
      if ((app === 'calendar' || app === 'reminders') && !fs.existsSync(resolveCalendarHelper())) {
        console.error(
          `[apple] not starting ${app} — calendar-helper binary missing (run scripts/build-calendar-helper.sh)`,
        );
        disabledServerNames.add(serverName);
        continue;
      }

      const appConfig = config.apps[app];
      factories[serverName] = () => createAppleServer(app, appConfig);
    }

    return { factories, disabledServerNames };
  },
};
