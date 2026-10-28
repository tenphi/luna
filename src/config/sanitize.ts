import { DEFAULT_SKILLS_DISABLED } from '../container-skills.js';
import { DEFAULT_APPLE_DOC } from './apple-defaults.js';
import { DEFAULT_EMAIL_DOC, EMAIL_DEFAULT_TOOLS_ALLOW } from './email-defaults.js';
import type { AgentConfigDoc, LunaConfigDoc, AppleAppDoc, AppleConfigDoc, EmailConfigDoc } from './schema.js';

const DEFAULT_MCP_PORT = 18800;

function sortedArraysEqual(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function isEmptyPackages(p: AgentConfigDoc['packages'] | undefined): boolean {
  return (p?.apt?.length ?? 0) === 0 && (p?.npm?.length ?? 0) === 0;
}

/**
 * Strip product defaults and empty scaffolding from the agent section before
 * persisting to config/local.jsonc. Local overlay should only contain overrides.
 */
export function sanitizeAgentForLocalOverlay(doc: AgentConfigDoc): AgentConfigDoc {
  const out: AgentConfigDoc = { ...doc };

  if (out.skills === 'all') delete out.skills;

  if (out.skillsEnabled && out.skillsDisabled) {
    out.skillsEnabled = out.skillsEnabled.filter((s) => !out.skillsDisabled!.includes(s));
    if (out.skillsEnabled.length === 0) delete out.skillsEnabled;
  }

  if (out.skillsDisabled && sortedArraysEqual(out.skillsDisabled, DEFAULT_SKILLS_DISABLED)) {
    delete out.skillsDisabled;
  }

  if (out.skillsEnabled?.length === 0) delete out.skillsEnabled;

  // cliScope defaults to global for the install agent — only persist non-default overrides.
  if (out.cliScope === 'agent' || out.cliScope === 'group' || out.cliScope === 'global') {
    delete out.cliScope;
  }

  delete out.provider;
  delete out.model;
  delete out.assistantName;
  delete out.mcpServers;
  if (isEmptyPackages(out.packages)) delete out.packages;
  if (out.additionalMounts?.length === 0) delete out.additionalMounts;

  return out;
}

function sameAppDoc(a: AppleAppDoc | undefined, b: AppleAppDoc | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    (a.enabled === undefined || a.enabled === b.enabled) &&
    (a.safetyMode === undefined || a.safetyMode === b.safetyMode) &&
    (a.defaultCalendar === undefined || a.defaultCalendar === b.defaultCalendar) &&
    (a.defaultList === undefined || a.defaultList === b.defaultList) &&
    (a.defaultFolder === undefined || a.defaultFolder === b.defaultFolder)
  );
}

/** Strip product Apple defaults before persisting to local.jsonc. */
export function sanitizeAppleForLocalOverlay(doc: AppleConfigDoc): AppleConfigDoc {
  const out: AppleConfigDoc = { ...doc, apps: doc.apps ? { ...doc.apps } : undefined };
  const defaults = DEFAULT_APPLE_DOC;

  if (out.enabled === defaults.enabled) delete out.enabled;

  if (out.apps) {
    for (const app of ['calendar', 'reminders', 'notes', 'messages', 'contacts'] as const) {
      const appDoc = out.apps[app];
      if (!appDoc) continue;
      const def = defaults.apps?.[app];
      if (def && sameAppDoc(appDoc, def)) {
        delete out.apps[app];
        continue;
      }
      const trimmed: AppleAppDoc = { ...appDoc };
      if (def && trimmed.enabled === def.enabled) delete trimmed.enabled;
      if (def && (trimmed.safetyMode === def.safetyMode || trimmed.safetyMode === 'normal')) {
        delete trimmed.safetyMode;
      }
      if (app === 'calendar' && trimmed.defaultCalendar === def?.defaultCalendar) {
        delete trimmed.defaultCalendar;
      }
      if (app === 'reminders' && trimmed.defaultList === def?.defaultList) delete trimmed.defaultList;
      if (app === 'notes' && trimmed.defaultFolder === def?.defaultFolder) delete trimmed.defaultFolder;
      if (Object.keys(trimmed).length === 0) delete out.apps[app];
      else out.apps[app] = trimmed;
    }
    if (Object.keys(out.apps).length === 0) delete out.apps;
  }

  return out;
}

function sameToolsAllow(a: string[] | undefined, b: readonly string[]): boolean {
  if (!a) return false;
  return sortedArraysEqual(a, b);
}

/**
 * Keys the mail builtin no longer has. Dropped on any write rather than left to rot.
 *
 * They cannot be typed away: a `local.jsonc` written before the Gmail rewrite still carries them,
 * and every merge path spreads the stored section forward. Without this, `accounts` and
 * `foldersAllow` would survive every future `luna config email set` — inert, but reading as though
 * the install were still scoped by folder when nothing enforces that any more.
 */
const RETIRED_EMAIL_KEYS = ['accounts', 'defaultAccount', 'configPath', 'foldersAllow'] as const;

/** Strip product email defaults and retired keys before persisting to local.jsonc. */
export function sanitizeEmailForLocalOverlay(doc: EmailConfigDoc): EmailConfigDoc {
  const out: EmailConfigDoc = { ...doc };
  const defaults = DEFAULT_EMAIL_DOC;

  for (const key of RETIRED_EMAIL_KEYS) {
    delete (out as Record<string, unknown>)[key];
  }

  if (out.enabled === defaults.enabled) delete out.enabled;
  if (out.backend === defaults.backend) delete out.backend;
  if (out.maxBodyChars === defaults.maxBodyChars) delete out.maxBodyChars;
  if (sameToolsAllow(out.toolsAllow, EMAIL_DEFAULT_TOOLS_ALLOW)) delete out.toolsAllow;

  return out;
}

/** Sanitize a full local document before writing to disk. */
export function sanitizeLocalDocument(doc: LunaConfigDoc): LunaConfigDoc {
  const out: LunaConfigDoc = { ...doc };

  if (out.install) {
    const install = { ...out.install } as Record<string, unknown>;
    delete install.defaultProvider;
    delete install.defaultModel;
    const cleaned = install as typeof out.install;
    if (Object.keys(cleaned).length === 0) delete out.install;
    else out.install = cleaned;
  }

  if (out.mcpPort === DEFAULT_MCP_PORT) delete out.mcpPort;
  if (out.mcpServers && Object.keys(out.mcpServers).length === 0) delete out.mcpServers;
  if (out.providers) {
    const providers = { ...out.providers };
    for (const [name, entry] of Object.entries(providers)) {
      if (!entry) {
        delete providers[name];
        continue;
      }
      const cleaned = { ...entry };
      if (cleaned.kind === 'openai-compatible' || cleaned.kind === null) delete cleaned.kind;
      if (Object.keys(cleaned).length === 0) delete providers[name];
      else providers[name] = cleaned;
    }
    if (Object.keys(providers).length === 0) delete out.providers;
    else out.providers = providers;
  }
  if (out.models) {
    const models = { ...out.models };
    for (const role of ['main'] as const) {
      const rc = models[role];
      if (!rc) continue;
      const cleaned = { ...rc };
      if (cleaned.id === null || cleaned.id === '') delete cleaned.id;
      if (cleaned.provider === null || cleaned.provider === '') delete cleaned.provider;
      if (Object.keys(cleaned).length === 0) delete models[role];
      else models[role] = cleaned;
    }
    if (Object.keys(models).length === 0) delete out.models;
    else out.models = models;
  }

  if (out.agent) {
    const agent = sanitizeAgentForLocalOverlay(out.agent);
    if (Object.keys(agent).length === 0) delete out.agent;
    else out.agent = agent;
  }
  if (out.apple) {
    const apple = sanitizeAppleForLocalOverlay(out.apple);
    if (Object.keys(apple).length === 0) delete out.apple;
    else out.apple = apple;
  }
  if (out.email) {
    const email = sanitizeEmailForLocalOverlay(out.email);
    if (Object.keys(email).length === 0) delete out.email;
    else out.email = email;
  }
  return out;
}
