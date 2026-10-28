import type {
  AppleAppId,
  AppleAppConfig,
  AppleConfig,
  AppleSafetyMode,
} from '../host-mcp/builtins/apple/shared/types.js';
import { APPLE_APP_ORDER } from '../host-mcp/builtins/apple/shared/types.js';
import { DEFAULT_APPLE_DOC } from './apple-defaults.js';
import type { AppleAppDoc, AppleConfigDoc, AppleSafetyModeDoc } from './schema.js';

function parseSafetyMode(value: AppleSafetyModeDoc | undefined): AppleSafetyMode | undefined {
  if (value === 'read-only' || value === 'confirm-destructive' || value === 'normal') return value;
  return undefined;
}

function appFromDoc(app: AppleAppId, doc: AppleAppDoc | undefined, fallback: AppleAppDoc): AppleAppConfig {
  const base = { ...fallback, ...doc };
  const out: AppleAppConfig = {
    enabled: base.enabled ?? true,
    safetyMode: parseSafetyMode(base.safetyMode) ?? 'normal',
  };
  if (app === 'calendar') out.defaultCalendar = base.defaultCalendar ?? null;
  if (app === 'reminders') out.defaultList = base.defaultList ?? null;
  if (app === 'notes') out.defaultFolder = base.defaultFolder ?? null;
  return out;
}

/** Build runtime Apple builtin config from unified config doc. */
export function appleDocToRuntime(doc: AppleConfigDoc | undefined): AppleConfig {
  const defaults = DEFAULT_APPLE_DOC;
  const apps = {} as Record<AppleAppId, AppleAppConfig>;
  for (const app of APPLE_APP_ORDER) {
    apps[app] = appFromDoc(app, doc?.apps?.[app], defaults.apps![app]!);
  }
  return {
    enabled: doc?.enabled ?? defaults.enabled ?? true,
    apps,
  };
}

function appToDoc(app: AppleAppId, cfg: AppleAppConfig): AppleAppDoc {
  const out: AppleAppDoc = { enabled: cfg.enabled };
  if (cfg.safetyMode && cfg.safetyMode !== 'normal') out.safetyMode = cfg.safetyMode;
  if (app === 'calendar' && cfg.defaultCalendar) out.defaultCalendar = cfg.defaultCalendar;
  if (app === 'reminders' && cfg.defaultList) out.defaultList = cfg.defaultList;
  if (app === 'notes' && cfg.defaultFolder) out.defaultFolder = cfg.defaultFolder;
  return out;
}

/** Map runtime Apple config to unified doc for local overlay writes. */
export function appleRuntimeToDoc(config: AppleConfig): AppleConfigDoc {
  const apps: NonNullable<AppleConfigDoc['apps']> = {};
  for (const app of APPLE_APP_ORDER) {
    apps[app] = appToDoc(app, config.apps[app]);
  }
  return { enabled: config.enabled, apps };
}
