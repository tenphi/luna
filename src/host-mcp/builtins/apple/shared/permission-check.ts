/** A fresh Luna bundle process can observe grants cached as denied by the host. */
import { APPLE_APP_ORDER, type AppleAppId } from './types.js';
import { probeApp, type AppHealth } from './permissions.js';

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  if (requested.some((app) => !APPLE_APP_ORDER.includes(app as AppleAppId))) {
    throw new Error('Unknown Apple permission probe');
  }
  const health: Partial<Record<AppleAppId, AppHealth>> = {};
  for (const app of requested as AppleAppId[]) health[app] = await probeApp(app);
  process.stdout.write(JSON.stringify(health));
}

main().catch((err) => {
  console.error('[apple permission check]', err);
  process.exitCode = 1;
});
