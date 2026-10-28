/**
 * Rebuild the Luna `.app` bundle and repoint the launchd plist at it, so
 * macOS TCC (Calendar/Reminders EventKit; Notes/Contacts/Messages Automation)
 * can grant the stable bundle identity.
 * Also embeds the vendored calendar-helper inside the bundle (required for EventKit).
 *
 * Run: pnpm exec tsx scripts/apple-install-app-wrapper.ts
 * Then complete the Calendar prompts when Luna opens.
 *
 * Note: `luna service install` / start / restart already keep the plist on the
 * `.app` launcher — this script is for priming GUI TCC prompts.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel } from '../src/install-slug.js';
import {
  ensureLaunchdPlistUsesAppBundle,
  getAppBundlePath,
} from '../setup/macos-app-bundle.js';

function main(): void {
  if (os.platform() !== 'darwin') {
    console.error('macOS only.');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const homeDir = os.homedir();
  const nodePath = process.execPath;

  const label = getLaunchdLabel(projectRoot);
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  if (!fs.existsSync(plistPath)) {
    console.error(`Plist not found: ${plistPath} (run setup first)`);
    process.exit(1);
  }

  const { rewritten, executable } = ensureLaunchdPlistUsesAppBundle(
    plistPath,
    projectRoot,
    nodePath,
  );
  console.log(`Built .app bundle executable: ${executable}`);
  console.log(
    rewritten
      ? `Repointed plist ProgramArguments at the bundle: ${plistPath}`
      : `Plist already targets the Luna .app: ${plistPath}`,
  );

  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  } catch {
    /* not loaded */
  }
  execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  console.log('Reloaded launchd service.');

  // Launch the bundle from the GUI (no args → permission primer). This is the
  // ONLY context where macOS will show the Calendar / Reminders TCC dialog and
  // attribute the grant to the bundle identity that the launchd job also uses.
  const appPath = getAppBundlePath(projectRoot);
  try {
    execSync(`open -a ${JSON.stringify(appPath)} -n`, { stdio: 'ignore' });
    console.log(`Launched ${appPath} to prime permissions.`);
  } catch (err) {
    console.warn('Could not open the bundle to prime permissions:', err);
  }

  console.log('');
  console.log('macOS should now prompt for Calendar/Reminders (EventKit) and Notes/Contacts/Messages (Automation) access.');
  console.log('Allow them. For Messages, also grant Full Disk Access to this Luna app.');
  console.log('Luna detects newly granted Apple permissions and redeploys automatically. Then verify:');
  console.log('  luna health');
}

main();
