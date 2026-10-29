import fs from 'fs';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { parseJsonc } from './jsonc.js';
import { mergeLunaConfig } from './merge.js';
import { normalizeLunaConfig } from './normalize.js';
import { resolveProviderModel } from './unified-agent.js';
import { defaultConfigPath, localConfigPath } from './paths.js';
import type {
  LunaConfigDoc,
  ModelRole,
  ModelRoleConfig,
  NamedProviderConfig,
  ProviderKind,
  SecretOrValue,
} from './schema.js';

let cached: LunaConfigDoc | null = null;
let layerErrors: ConfigLayerError[] = [];

export interface ConfigLayerError {
  path: string;
  message: string;
}

export function clearConfigCache(): void {
  cached = null;
  layerErrors = [];
}

/**
 * Layers that exist on disk but could not be parsed, from the last load.
 *
 * Surfaced by `luna health` and logged at host start. A caller that only needs the config itself
 * can ignore this; a caller reporting on the install's state cannot, because the fallback for an
 * unparseable layer is "pretend it isn't there".
 */
export function configLayerErrors(): ConfigLayerError[] {
  loadLunaConfig();
  return [...layerErrors];
}

/**
 * Read one layer. A missing file and an unparseable file are *not* the same thing.
 *
 * Both used to return null, so a `local.jsonc` with a stray comma degraded to product defaults and
 * looked exactly like a fresh install. That was survivable while the file held endpoints and
 * timeouts — a wrong model id fails loudly on the next call. It stops being survivable now that the
 * file holds the user roster: silently dropping the layer reads as "nobody is authorized", which is
 * indistinguishable from a correct empty install and locks the owner out of their own assistant.
 */
function readLayer(filePath: string): LunaConfigDoc | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonc<LunaConfigDoc>(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    layerErrors.push({ path: filePath, message });
    log.error('Config layer exists but could not be parsed — ignoring it', { path: filePath, err: message });
    return null;
  }
}

/**
 * Keys that were removed rather than renamed, and what replaced them.
 *
 * Reported, not enforced. A file carrying one of these is stale, and staying quiet about it means
 * an operator who scoped their install with `foldersAllow` believes it is still scoped when it no
 * longer exists — the exact silent-degradation this loader already refuses elsewhere. But refusing
 * to *load* over it would be worse: the same file holds the roster, and rejecting the layer reads
 * as "nobody is authorized". So it surfaces in `luna health` and in the log at start, and the
 * config still loads.
 */
const RETIRED_EMAIL_KEYS: Record<string, string> = {
  accounts: 'mailboxes live on the person now — users.<key>.email',
  defaultAccount: 'the mailbox defaults to the person you are talking to',
  configPath: 'there is no external mail config file any more',
  foldersAllow: 'there are no folders — spam and trash are excluded by the query itself',
};

function noteRetiredKeys(doc: LunaConfigDoc | null, filePath: string): void {
  const email = doc?.email as Record<string, unknown> | undefined;
  if (!email) return;
  for (const [key, replacement] of Object.entries(RETIRED_EMAIL_KEYS)) {
    if (!(key in email)) continue;
    const message = `email.${key} was removed and is being ignored — ${replacement}`;
    layerErrors.push({ path: filePath, message });
    log.warn('Config carries a removed key', { path: filePath, key: `email.${key}` });
  }
}

/** Load and merge config layers: default.jsonc → local.jsonc. Secrets resolve via .env at read time. */
export function loadLunaConfig(): LunaConfigDoc {
  if (cached) return cached;

  layerErrors = [];
  const local = readLayer(localConfigPath());
  const layers: LunaConfigDoc[] = [readLayer(defaultConfigPath()) ?? {}, local ?? {}];
  noteRetiredKeys(local, localConfigPath());

  cached = normalizeLunaConfig(mergeLunaConfig(layers));
  return cached;
}

/** Resolve a secret ref or literal string from .env / process.env. */
export function resolveSecretOrValue(value: SecretOrValue | undefined, processEnv = process.env): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value || undefined;
  const fromProcess = processEnv[value.env];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromFile = readEnvFile([value.env])[value.env];
  return fromFile || undefined;
}

/** Where `auth: "chatgpt"` providers send Responses calls unless `baseUrl` says otherwise. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export interface ResolvedProvider {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  api?: 'responses' | 'chat-completions';
  /** Set when the provider bills the local ChatGPT login rather than an API key. */
  auth?: 'chatgpt';
  apiKey?: string;
  apiKeyEnv?: string;
  extraBody?: Record<string, unknown>;
}

export interface ResolvedModelRole {
  role: ModelRole;
  provider: ResolvedProvider;
  id?: string;
}

function resolveNamedProvider(name: string, cfg = loadLunaConfig()): ResolvedProvider {
  const entry: NamedProviderConfig | undefined = cfg.providers?.[name];
  const kind: ProviderKind = entry?.kind === 'llama-server-reranker' ? 'llama-server-reranker' : 'openai-compatible';
  const extraBody =
    entry?.extraBody && typeof entry.extraBody === 'object' ? (entry.extraBody as Record<string, unknown>) : undefined;

  if (entry?.auth === 'chatgpt') {
    // The login is read per request by the host proxy (providers/chatgpt.ts), never resolved here,
    // so no API key can fall back in and travel to the container instead.
    return {
      name,
      kind,
      baseUrl: resolveSecretOrValue(entry.baseUrl ?? undefined) ?? CHATGPT_CODEX_BASE_URL,
      api: 'responses',
      auth: 'chatgpt',
      extraBody,
    };
  }

  const configuredApiKeyEnv = entry?.apiKeyEnv?.trim() || undefined;
  let apiKey: string | undefined;
  let apiKeyEnv: string | undefined;

  if (configuredApiKeyEnv) {
    apiKey = process.env[configuredApiKeyEnv] || readEnvFile([configuredApiKeyEnv])[configuredApiKeyEnv] || undefined;
    if (apiKey) apiKeyEnv = configuredApiKeyEnv;
  }
  if (!apiKey && entry?.apiKey !== undefined && entry.apiKey !== null) {
    apiKey = resolveSecretOrValue(entry.apiKey);
    if (apiKey && typeof entry.apiKey === 'object' && 'env' in entry.apiKey) {
      apiKeyEnv = entry.apiKey.env;
    }
  }
  // Default openai provider falls back to OPENAI_API_KEY when unset.
  if (!apiKey && name === 'openai') {
    const dotenv = readEnvFile(['OPENAI_API_KEY']);
    apiKey = process.env.OPENAI_API_KEY ?? dotenv.OPENAI_API_KEY;
    if (apiKey) apiKeyEnv = 'OPENAI_API_KEY';
  }

  return {
    name,
    kind,
    baseUrl: resolveSecretOrValue(entry?.baseUrl ?? undefined),
    ...(entry?.api === 'responses' || entry?.api === 'chat-completions' ? { api: entry.api } : {}),
    apiKey,
    apiKeyEnv,
    extraBody,
  };
}

function roleConfig(role: ModelRole, cfg = loadLunaConfig()): ModelRoleConfig | undefined {
  return cfg.models?.[role];
}

/** Provider name for the role: explicit → "openai". No inheritance — there is one role. */
export function resolveModelProviderName(role: ModelRole, cfg = loadLunaConfig()): string {
  return roleConfig(role, cfg)?.provider?.trim() || 'openai';
}

/** Resolve the configured model role. */
export function resolveModelRole(role: ModelRole, cfg = loadLunaConfig()): ResolvedModelRole {
  const rc = roleConfig(role, cfg) ?? {};
  const provider = resolveNamedProvider(resolveModelProviderName(role, cfg), cfg);
  return { role, provider, id: rc.id?.trim() || undefined };
}

/** Install-wide default provider/model with models.main precedence. */
export function resolveInstallDefaults(): { provider?: string; model?: string } {
  return resolveProviderModel(loadLunaConfig());
}

/**
 * Agent-runner implementation for a `providers` entry name.
 *
 * `models.main.provider` names an entry under `providers` — an endpoint plus
 * credentials. The agent runner needs something different: the id of a
 * registered provider *implementation* (`openai`, `mock`, …). Those are two
 * namespaces, and resolving the second by reusing the first's key is what used
 * to force every OpenAI-compatible endpoint to literally be named "openai" —
 * `providers.blackboxai` died with `Unknown provider: blackboxai` in the
 * container even though it speaks the same wire protocol.
 *
 * The wire protocol is what `kind` already records, so map from that instead.
 * Names not present under `providers` pass through untouched, which keeps
 * `mock` (and any implementation registered directly) working.
 */
const RUNNER_BY_KIND: Record<ProviderKind, string> = {
  'openai-compatible': 'openai',
  // Not a chat runner — reaches createProvider() only via a misconfigured
  // models.main, where the registry's "Unknown provider" is the right error.
  'llama-server-reranker': 'llama-server-reranker',
};

export function resolveRunnerProvider(name: string | null | undefined, cfg = loadLunaConfig()): string {
  const configured = name?.trim();
  if (!configured) return 'openai';

  const entry = cfg.providers?.[configured] ?? cfg.providers?.[configured.toLowerCase()];
  if (!entry) return configured.toLowerCase();

  return RUNNER_BY_KIND[entry.kind ?? 'openai-compatible'] ?? configured.toLowerCase();
}

/**
 * Agent chat OpenAI settings from models.main + its provider.
 * Kept name for call-site compatibility.
 */
export function resolveOpenAiProviderConfig(): {
  baseUrl?: string;
  api?: 'responses' | 'chat-completions';
  auth?: 'chatgpt';
  apiKey?: string;
  model?: string;
  extraBody?: Record<string, unknown>;
} {
  const main = resolveModelRole('main');
  return {
    baseUrl: main.provider.baseUrl,
    ...(main.provider.api ? { api: main.provider.api } : {}),
    ...(main.provider.auth ? { auth: main.provider.auth } : {}),
    apiKey: main.provider.apiKey,
    model: main.id,
    extraBody: main.provider.extraBody,
  };
}

export { defaultConfigPath, localConfigPath, parseJsonc };
