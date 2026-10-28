import { appleDocToRuntime, appleRuntimeToDoc } from '../../../../config/apple-bridge.js';
import { loadLunaConfig } from '../../../../config/loader.js';
import { sanitizeAppleForLocalOverlay } from '../../../../config/sanitize.js';
import { patchLocalConfig } from '../../../../config/write.js';
import { readEnvFile } from '../../../../env.js';
import type { AppleAppId, AppleConfig } from './types.js';
import { APPLE_APP_ORDER } from './types.js';

export type { AppleAppId, AppleAppConfig, AppleConfig, AppleSafetyMode } from './types.js';
export { APPLE_SERVER_KEYS, APPLE_APP_ORDER } from './types.js';

const ENV_KEYS = [
  'LUNA_APPLE_ENABLED',
  'LUNA_APPLE_DEFAULT_CALENDAR',
  'LUNA_APPLE_DEFAULT_REMINDERS_LIST',
  'LUNA_APPLE_DEFAULT_NOTES_FOLDER',
  'LUNA_APPLE_CALENDAR_ENABLED',
  'LUNA_APPLE_REMINDERS_ENABLED',
  'LUNA_APPLE_NOTES_ENABLED',
  'LUNA_APPLE_MESSAGES_ENABLED',
  'LUNA_APPLE_CONTACTS_ENABLED',
] as const;

function envValue(key: (typeof ENV_KEYS)[number]): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  return readEnvFile([...ENV_KEYS])[key];
}

export const DEFAULT_APPLE_CONFIG: AppleConfig = appleDocToRuntime(undefined);

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0';
}

function appEnabled(app: AppleAppId, fileValue: boolean): boolean {
  const key = `LUNA_APPLE_${app.toUpperCase()}_ENABLED` as const;
  const env = envValue(key as (typeof ENV_KEYS)[number]);
  if (env !== undefined && env !== '') return parseBool(env, fileValue);
  return fileValue;
}

export function isAppleEnabledInstallWide(): boolean {
  const unified = loadLunaConfig().apple;
  if (unified?.enabled === false) return false;
  return envValue('LUNA_APPLE_ENABLED') !== 'false';
}

export function loadAppleConfig(): AppleConfig {
  const base = appleDocToRuntime(loadLunaConfig().apple);

  const defaultCalendar = envValue('LUNA_APPLE_DEFAULT_CALENDAR');
  if (defaultCalendar) base.apps.calendar.defaultCalendar = defaultCalendar;

  const defaultList = envValue('LUNA_APPLE_DEFAULT_REMINDERS_LIST');
  if (defaultList) base.apps.reminders.defaultList = defaultList;

  const defaultFolder = envValue('LUNA_APPLE_DEFAULT_NOTES_FOLDER');
  if (defaultFolder) base.apps.notes.defaultFolder = defaultFolder;

  base.enabled = parseBool(envValue('LUNA_APPLE_ENABLED'), base.enabled);
  for (const app of APPLE_APP_ORDER) {
    base.apps[app].enabled = appEnabled(app, base.apps[app].enabled);
  }

  return base;
}

/** Persist Apple builtin settings to config/local.jsonc. */
export function saveAppleConfig(config: AppleConfig): void {
  const doc = sanitizeAppleForLocalOverlay(appleRuntimeToDoc(config));
  if (Object.keys(doc).length === 0) return;
  patchLocalConfig('apple', doc);
}

export function seedAppleConfigIfMissing(): AppleConfig {
  return loadAppleConfig();
}

export function isAppEnabled(config: AppleConfig, app: AppleAppId): boolean {
  return config.enabled && config.apps[app].enabled;
}
