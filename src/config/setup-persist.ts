/**
 * Setup-time persistence: non-secrets → config/local.jsonc, secrets → `.env`.
 * Also strips migrated keys from `.env` so re-runs do not duplicate config.
 */
import { removeEnvKeys, writeEnvFile } from '../env.js';
import { SETUP_STRIP_ENV_KEYS } from './env-overlay.js';
import type { LunaConfigDoc } from './schema.js';
import { writeLocalConfig } from './write.js';

function mirrorProcessEnv(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

/** Write secrets to `.env` and mirror into process.env for the current setup run. */
export function persistSetupSecrets(updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  writeEnvFile(updates);
  mirrorProcessEnv(updates);
}

/** Remove install settings that now live in local.jsonc from `.env`. */
export function stripSetupLocalEnvKeys(): void {
  removeEnvKeys([...SETUP_STRIP_ENV_KEYS]);
}

/**
 * Write the roster collected during setup.
 *
 * Typed rather than routed through `patchLocalConfig`, whose `LunaConfigDoc[typeof section]` signature
 * collapses to a union of every section and so type-checks nothing — which is a poor trade for the one
 * section where a wrong shape means nobody can talk to the install.
 *
 * Worth knowing at the call site: `writeLocalConfig` rewrites `config/local.jsonc` as plain JSON, so
 * any comments the operator has added to it are lost. That is pre-existing (`persistTimezone` does it
 * too), but a roster makes such writes routine.
 */
export function persistRoster(opts: { users: NonNullable<LunaConfigDoc['users']>; owner: string }): void {
  writeLocalConfig({ users: opts.users, owner: opts.owner });
}

export function persistOpenAiEndpoint(opts: {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  provider?: string;
}): void {
  const provider = opts.provider ?? 'openai';
  const patch: LunaConfigDoc = {
    providers: { [provider]: { baseUrl: opts.baseUrl } },
    models: {
      main: {
        provider,
        ...(opts.model ? { id: opts.model } : {}),
      },
    },
  };

  writeLocalConfig(patch);
  removeEnvKeys(['OPENAI_BASE_URL', 'OPENAI_MODEL', 'LUNA_DEFAULT_MODEL', 'LUNA_DEFAULT_PROVIDER']);
  if (opts.apiKey) persistSetupSecrets({ OPENAI_API_KEY: opts.apiKey });
}

export function persistOnecliUrl(url: string): void {
  writeLocalConfig({ install: { onecli: { url } } });
  removeEnvKeys(['ONECLI_URL']);
  process.env.ONECLI_URL = url;
}

export function persistOnecliApiKey(apiKey: string): void {
  writeLocalConfig({
    install: { onecli: { apiKey: { env: 'ONECLI_API_KEY' } } },
  });
  persistSetupSecrets({ ONECLI_API_KEY: apiKey });
}

export function persistTimezone(timezone: string): void {
  writeLocalConfig({ install: { timezone } });
  removeEnvKeys(['TZ']);
  process.env.TZ = timezone;
}
