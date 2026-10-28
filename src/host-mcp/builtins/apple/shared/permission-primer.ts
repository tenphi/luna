/**
 * Permission primer — run from the Luna `.app` bundle on GUI launch
 * (`open -a Luna`). Because this executes as the bundle executable in a
 * foreground GUI context, macOS CAN present Calendar (EventKit), Reminders,
 * Contacts, Notes, and Messages TCC dialogs and attribute the
 * grants to the bundle identity. The launchd background process (same
 * CFBundleIdentifier) then inherits the grant.
 *
 * It probes each enabled Apple app once, triggering the OS prompt, then
 * writes health.json and exits. A running host observes newly granted Apple
 * permissions and redeploys the current build automatically.
 *
 * Speech Recognition rides along for the same reason: transcribing voice messages on-device
 * needs a grant that only a foreground bundle can ask for, and asking here means one trip
 * through the prompts instead of two.
 */
import { loadLunaConfig } from '../../../../config/loader.js';
import { authorizeSpeech } from '../../../../voice/macos.js';
import { APPLE_APP_ORDER } from './types.js';
import { isAppEnabled, loadAppleConfig } from './config.js';
import { runPermissionDryRun } from './permissions.js';

/**
 * Ask for Speech Recognition, unless this install does not use the on-device recogniser.
 *
 * `backend: 'model'` sends audio to a transcription endpoint and never touches the Speech
 * framework, so prompting for it would be asking the owner to grant something Luna will not use.
 */
async function primeSpeech(): Promise<void> {
  const voice = loadLunaConfig().voice ?? {};
  if (voice.enabled === false || voice.backend === 'model') return;

  const languages = voice.languages ?? ['en-US'];
  try {
    const result = await authorizeSpeech(languages);
    const offDevice = result.locales.filter((entry) => !entry.onDevice).map((entry) => entry.locale);
    // eslint-disable-next-line no-console
    console.log(
      `speech: [${result.authorization}] on-device for ${
        result.locales
          .filter((entry) => entry.onDevice)
          .map((entry) => entry.locale)
          .join(', ') || 'nothing'
      }`,
    );
    if (offDevice.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `speech: macOS has no on-device asset for ${offDevice.join(', ')} — those fall back to models.transcribe.`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`speech: [error] ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  // Force the "interactive" code path so we don't append launchd hints and so
  // EventKit treats us as a foreground requester.
  process.env.LUNA_APPLE_FORCE_INTERACTIVE = '1';

  const config = loadAppleConfig();
  const disabled = new Set(APPLE_APP_ORDER.filter((app) => !isAppEnabled(config, app)));

  // eslint-disable-next-line no-console
  console.log('Luna Apple permission primer — allow any system prompts that appear.');
  // eslint-disable-next-line no-console
  console.log('For Messages: also grant Full Disk Access to this Luna app in System Settings.');

  await primeSpeech();

  const health = await runPermissionDryRun(APPLE_APP_ORDER, disabled);
  for (const app of APPLE_APP_ORDER) {
    const h = health[app];
    // eslint-disable-next-line no-console
    console.log(`${app}: [${h.status}] ${h.message.split('\n')[0]}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[apple primer]', err);
  process.exit(1);
});
