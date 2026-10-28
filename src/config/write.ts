import fs from 'fs';

import { clearConfigCache } from './loader.js';
import { parseJsonc } from './jsonc.js';
import { mergeApple, mergeEmail } from './merge.js';
import { configDir, localConfigPath } from './paths.js';
import { sanitizeLocalDocument } from './sanitize.js';
import type { LunaConfigDoc, NamedProviderConfig, ProvidersConfig } from './schema.js';

function readLocalRaw(): LunaConfigDoc {
  const localPath = localConfigPath();
  try {
    if (!fs.existsSync(localPath)) return {};
    return parseJsonc<LunaConfigDoc>(fs.readFileSync(localPath, 'utf-8'));
  } catch {
    return {};
  }
}

function mergeProvidersPatch(current: ProvidersConfig | undefined, patch: ProvidersConfig): ProvidersConfig {
  const out: ProvidersConfig = { ...(current ?? {}) };
  for (const [name, entry] of Object.entries(patch)) {
    if (entry === undefined) continue;
    out[name] = { ...(current?.[name] as NamedProviderConfig | undefined), ...entry };
  }
  return out;
}

/** One role, so the merge is one shallow spread. */
function mergeModelsPatch(
  current: LunaConfigDoc['models'],
  patch: NonNullable<LunaConfigDoc['models']>,
): LunaConfigDoc['models'] {
  return { ...current, ...(patch.main ? { main: { ...current?.main, ...patch.main } } : {}) };
}

/** Write local overlay; top-level sections in `patch` replace/merge the stored section body. */
export function writeLocalConfig(patch: LunaConfigDoc): string {
  const localPath = localConfigPath();
  fs.mkdirSync(configDir(), { recursive: true });
  const current = readLocalRaw();
  const merged: LunaConfigDoc = { ...current };

  if (patch.install) merged.install = { ...current.install, ...patch.install };
  if (patch.mcpPort !== undefined) merged.mcpPort = patch.mcpPort;
  // Per-key merge, so `luna config users set --key bo …` cannot drop ada. A `null` value
  // removes that person, matching what the merge layer does with an explicit null.
  if (patch.users) {
    const users = { ...(current.users ?? {}) };
    for (const [key, entry] of Object.entries(patch.users)) {
      if (entry === null || entry === undefined) delete users[key];
      else users[key] = { ...users[key], ...entry };
    }
    merged.users = users;
  }
  if (patch.owner !== undefined) merged.owner = patch.owner;
  if ('mcpServers' in patch) {
    if (patch.mcpServers && Object.keys(patch.mcpServers).length > 0) merged.mcpServers = patch.mcpServers;
    else delete merged.mcpServers;
  }
  if (patch.agent) merged.agent = patch.agent;
  // Shallow-merged like the rest: `luna config memory set --digest false` must not drop a mission
  // the owner set last week.
  if (patch.memory) merged.memory = { ...current.memory, ...patch.memory };
  if (patch.providers) {
    merged.providers = mergeProvidersPatch(current.providers, patch.providers);
  }
  if (patch.models) {
    merged.models = mergeModelsPatch(current.models, patch.models);
  }
  if (patch.apple) merged.apple = mergeApple(current.apple, patch.apple);
  if (patch.email) merged.email = mergeEmail(current.email, patch.email);

  const sanitized = sanitizeLocalDocument(merged);
  const tmp = `${localPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2) + '\n');
  fs.renameSync(tmp, localPath);
  clearConfigCache();
  return localPath;
}

/** Patch a section of the local overlay. */
export function patchLocalConfig(section: keyof LunaConfigDoc, value: LunaConfigDoc[typeof section]): string {
  return writeLocalConfig({ [section]: value } as LunaConfigDoc);
}

export function localConfigExists(): boolean {
  return fs.existsSync(localConfigPath());
}
