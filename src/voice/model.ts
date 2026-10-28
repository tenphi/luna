/**
 * The model backend: a transcription endpoint, for the languages Apple cannot do on-device.
 *
 * `POST /v1/audio/transcriptions`, multipart, which is what every OpenAI-compatible endpoint
 * implements — hosted OpenAI, and a local whisper.cpp or LM Studio server just as well, so
 * "send it to a model" does not have to mean "send it off this machine". The endpoint comes from
 * the `transcribe` model role, so the provider and its credential resolve exactly like the
 * agent's own model does.
 *
 * The language is deliberately not pinned by default: these models identify it themselves, and
 * that is the whole reason this backend exists for a person who speaks two. `languages` is passed
 * only when exactly one is configured, where it is a real accuracy win and cannot misfire.
 *
 * ## Why this runs in a child process
 *
 * On an install with a OneCLI vault, `providers.openai.apiKey` is a *placeholder*: the real
 * credential lives in the vault, and the gateway injects it into requests that pass through its
 * authenticating proxy. Calling `api.openai.com` from this process with the placeholder gets
 * exactly what you would expect — `Incorrect API key provided: 136aO9x5…`.
 *
 * Node routes `fetch` through a proxy when `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` are set, but it
 * reads them once, process-wide, at first use. Setting them on the Luna host would push every
 * other thing it talks to — Telegram, IMAP, the memory socket — through the gateway too. Undici's
 * per-request `ProxyAgent` would be the alternative, and undici is not a dependency here.
 *
 * So the request runs in a short-lived `node` with the gateway's own environment, which is
 * precisely how Luna already routes host MCP servers through OneCLI (`buildHostOneCliEnv`). One
 * path, whether or not a vault is configured: without one the child simply inherits no proxy and
 * calls the endpoint directly with the configured key.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveModelRole } from '../config/loader.js';
import { CONTAINER_HOST_ALIAS } from '../container-runtime.js';
import { buildHostOneCliEnv } from '../host-mcp/onecli-env.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

export class TranscriptionModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionModelUnavailable';
  }
}

export interface ModelTranscriptionOptions {
  /** Overrides the configured `models.transcribe.id`. */
  model?: string | null;
  /** ISO-639-1 hints. Passed through only when there is exactly one. */
  languages?: string[];
  timeoutMs?: number;
  /** The OneCLI agent whose vault credentials apply. */
  agentGroupId?: string;
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  // A baseUrl may or may not already carry the version prefix; both spellings are common in
  // config files and both should work.
  return trimmed.endsWith('/v1') ? `${trimmed}/audio/transcriptions` : `${trimmed}/v1/audio/transcriptions`;
}

/** `en-US` → `en`, which is what the API's `language` field takes. */
function toIso639(locale: string): string {
  return locale.replace(/_/g, '-').split('-')[0]!.toLowerCase();
}

/**
 * The gateway hands out a container's view of the host. From the host itself that name does not
 * resolve, and the proxy is bound on loopback at the same port.
 */
function forHostUse(env: Record<string, string>): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    rewritten[key] = /proxy/i.test(key) ? value.replaceAll(CONTAINER_HOST_ALIAS, '127.0.0.1') : value;
  }
  return rewritten;
}

/**
 * The request, as source handed to `node -e`.
 *
 * Inline rather than a built file so it behaves identically under `tsx` and from `dist/` — a
 * path that only resolves after a build is a dev/prod split waiting to bite. Everything variable
 * arrives in argv; nothing is interpolated into the source.
 */
const REQUEST_SOURCE = `
const fs = require('node:fs');
const [url, file, model, language, timeoutMs] = process.argv.slice(1);

(async () => {
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'audio.wav');

  const headers = {};
  if (process.env.LUNA_TRANSCRIBE_KEY) headers.authorization = 'Bearer ' + process.env.LUNA_TRANSCRIBE_KEY;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(Number(timeoutMs)),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && body.error && body.error.message ? body.error.message : 'HTTP ' + response.status;
    process.stdout.write(JSON.stringify({ error: detail }));
    return;
  }
  process.stdout.write(JSON.stringify({ text: typeof body?.text === 'string' ? body.text : '' }));
})().catch((err) => {
  const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
  process.stdout.write(JSON.stringify({ error: timedOut ? 'the transcription model did not answer in time' : String(err && err.message || err) }));
});
`;

export async function transcribeWithModel(file: string, options: ModelTranscriptionOptions = {}): Promise<string> {
  const role = resolveModelRole('transcribe');
  const model = options.model?.trim() || role.id;
  if (!model) {
    throw new TranscriptionModelUnavailable(
      'no transcription model is configured — set `models.transcribe.id` (for example "gpt-transcribe")',
    );
  }
  if (!fs.existsSync(file)) {
    throw new TranscriptionModelUnavailable(`no audio to transcribe at ${path.basename(file)}`);
  }

  const baseUrl = role.provider.baseUrl?.trim() || 'https://api.openai.com/v1';
  const timeoutMs = options.timeoutMs ?? 120_000;

  // One language is a hint worth giving. Two or more is exactly the case the model's own
  // language identification handles better than we can guess per message.
  const languages = (options.languages ?? []).map(toIso639).filter((value, index, all) => all.indexOf(value) === index);
  const language = languages.length === 1 ? languages[0]! : '';

  const vault = await buildHostOneCliEnv(options.agentGroupId ?? 'luna-default');
  const env: Record<string, string> = {
    ...process.env,
    ...(vault ? forHostUse(vault) : {}),
    ...(role.provider.apiKey ? { LUNA_TRANSCRIBE_KEY: role.provider.apiKey } : {}),
  };
  // Without this Node ignores HTTPS_PROXY for fetch, the request goes straight out, and the
  // vault's placeholder key is rejected by the endpoint.
  if (vault) env.NODE_USE_ENV_PROXY = '1';

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      ['-e', REQUEST_SOURCE, endpoint(baseUrl), file, model, language, String(timeoutMs)],
      { env, timeout: timeoutMs + 15_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (err) {
    throw new TranscriptionModelUnavailable(
      `the transcription request could not be run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: { text?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(stdout.trim()) as { text?: unknown; error?: unknown };
  } catch {
    throw new TranscriptionModelUnavailable(`the transcription request returned no answer: ${stdout.slice(0, 200)}`);
  }
  if (typeof parsed.error === 'string') {
    throw new TranscriptionModelUnavailable(`the transcription model refused: ${parsed.error}`);
  }

  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  log.debug('model transcription finished', { model, chars: text.length, viaVault: vault !== null });
  return text;
}
