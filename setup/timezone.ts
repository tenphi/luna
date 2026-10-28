import { loadLunaConfig } from '../src/config/loader.js';
import { persistTimezone } from '../src/config/setup-persist.js';
import { readEnvFile } from '../src/env.js';
import { isValidTimezone } from '../src/timezone.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const specified = args.includes('--tz') ? args[args.indexOf('--tz') + 1] : undefined;
  if (args.includes('--tz') && (!specified || !isValidTimezone(specified))) throw new Error('--tz requires a valid time zone');
  const saved = loadLunaConfig().install?.timezone ?? readEnvFile(['TZ']).TZ;
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selected = [specified, saved, process.env.TZ, detected].find((zone) => zone && isValidTimezone(zone));
  if (selected && selected !== saved) persistTimezone(selected);
  emitStatus('TIMEZONE', {
    SYSTEM_TZ: detected || 'unknown', ENV_TZ: process.env.TZ || 'unset', ENV_FILE_TZ: saved || 'unset',
    RESOLVED_TZ: selected || 'none', NEEDS_USER_INPUT: !selected, STATUS: selected ? 'success' : 'needs_input',
  });
}
