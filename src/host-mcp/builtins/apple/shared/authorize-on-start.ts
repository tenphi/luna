import type { AppleAppId } from './config.js';
import type { AppHealth, AppleHealth } from './permissions.js';
import { isLaunchdLikeSession } from './launch-context.js';

/**
 * When running under launchd and an enabled app is not authorized, point the
 * operator at the permission primer. We do NOT auto-`open` anything here:
 * a background LaunchAgent cannot summon the macOS TCC dialog (the grant must
 * come from a foreground GUI launch of the `.app` bundle, which the primer
 * script handles). Spamming `open` on every restart only annoys; instead we
 * log a single actionable line.
 */
export function promptApplePermissionsOnStart(health: AppleHealth, enabledApps: AppleAppId[]): void {
  if (!isLaunchdLikeSession()) return;

  const denied = enabledApps.filter((app) => {
    const h: AppHealth = health[app];
    return h.status === 'denied' || h.status === 'error';
  });
  if (denied.length === 0) return;

  console.error(
    `[apple] not authorized: ${denied.join(', ')}. ` +
      `Run: luna setup step apple ` +
      `(grants Calendar/Reminders EventKit and Notes/Contacts/Messages Automation to the Luna .app bundle via a GUI prompt). ` +
      `For Messages, also grant Full Disk Access to the Luna app.`,
  );
}
