/**
 * The macOS backend: Apple's on-device speech recogniser, through the vendored Swift helper.
 *
 * Free, private, and fast — the audio never leaves the Mac and there is no per-message cost.
 * Its limit is assets: a locale Apple has not downloaded an "Assistant asset" for reports
 * `onDevice: false`, and recognising it would mean sending the audio to Apple. The helper
 * refuses that rather than downgrading quietly, and `selectBackend` in ./transcribe.ts routes
 * such installs to the model instead.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getInstallSlug } from '../install-slug.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = process.cwd();

export interface LocaleSupport {
  locale: string;
  supported: boolean;
  onDevice: boolean;
  available: boolean;
}

export interface SpeechProbe {
  authorization: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
  locales: LocaleSupport[];
}

export class SpeechUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechUnavailable';
  }
}

/** The committed universal binary, before the bundle copy exists. */
export function resolveNativeSpeechHelper(projectRoot: string = PROJECT_ROOT): string {
  return path.join(projectRoot, 'src', 'voice', 'native', 'speech-helper');
}

/**
 * Prefer the copy inside Luna.app.
 *
 * Speech Recognition is attributed by TCC to the responsible process, and only the bundle has a
 * stable identity that can hold a grant and raise a prompt — the same reason calendar-helper is
 * embedded. Falling back to the vendored binary keeps `pnpm dev` and the tests working, where
 * the grant is the developer's terminal.
 */
export function resolveSpeechHelper(projectRoot: string = PROJECT_ROOT): string {
  const bundled = path.join(
    projectRoot,
    'data',
    'mac-app',
    `Luna-${getInstallSlug(projectRoot)}.app`,
    'Contents',
    'MacOS',
    'speech-helper',
  );
  if (fs.existsSync(bundled)) return bundled;
  return resolveNativeSpeechHelper(projectRoot);
}

/**
 * The helper's JSON is one line on stdout, but the Speech framework writes its own diagnostics
 * there too — "No Assistant asset for language ru-RU" shows up whenever an absent locale is
 * constructed. Parse the last line that is actually JSON rather than the whole buffer.
 */
function parseHelperOutput(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  const last = lines.at(-1);
  if (!last) throw new SpeechUnavailable(`the speech helper printed no JSON: ${stdout.trim().slice(0, 200)}`);
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new SpeechUnavailable(`the speech helper printed unparseable JSON: ${last.slice(0, 200)}`);
  }
}

async function runHelper(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const helper = resolveSpeechHelper();
  if (!fs.existsSync(helper)) {
    throw new SpeechUnavailable(`the speech helper is missing at ${helper} — run scripts/build-speech-helper.sh`);
  }
  try {
    const { stdout } = await execFileAsync(helper, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return parseHelperOutput(stdout);
  } catch (err) {
    // A non-zero exit still carries the helper's `{"error":...}` on stdout, and that message is
    // far more useful than "Command failed".
    const withOutput = err as { stdout?: string };
    if (typeof withOutput.stdout === 'string' && withOutput.stdout.includes('{')) {
      const parsed = parseHelperOutput(withOutput.stdout);
      if (typeof parsed.error === 'string') throw new SpeechUnavailable(parsed.error);
    }
    if (err instanceof SpeechUnavailable) throw err;
    throw new SpeechUnavailable(err instanceof Error ? err.message : String(err));
  }
}

/** What this Mac can recognise, and whether Luna is allowed to ask it. */
export async function probeSpeech(locales: string[], timeoutMs = 30_000): Promise<SpeechProbe> {
  const args = ['probe'];
  if (locales.length > 0) args.push('--locales', locales.join(','));
  const parsed = await runHelper(args, timeoutMs);
  return {
    authorization: (parsed.authorization as SpeechProbe['authorization']) ?? 'unknown',
    locales: Array.isArray(parsed.locales) ? (parsed.locales as LocaleSupport[]) : [],
  };
}

/**
 * Ask TCC for Speech Recognition. Needs a GUI session to show the prompt, so this is what
 * `scripts/apple-grant-speech.command` runs — not something the launchd host does on boot.
 */
export async function authorizeSpeech(locales: string[], timeoutMs = 150_000): Promise<SpeechProbe> {
  const args = ['authorize'];
  if (locales.length > 0) args.push('--locales', locales.join(','));
  const parsed = await runHelper(args, timeoutMs);
  return {
    authorization: (parsed.authorization as SpeechProbe['authorization']) ?? 'unknown',
    locales: Array.isArray(parsed.locales) ? (parsed.locales as LocaleSupport[]) : [],
  };
}

export interface MacosTranscript {
  text: string;
  confidence: number;
  locale: string;
}

/** Recognise one prepared WAV. `onDevice` false would send the audio to Apple, so callers pass true. */
export async function transcribeWithMacos(
  file: string,
  locale: string,
  options: { onDevice?: boolean; timeoutMs?: number } = {},
): Promise<MacosTranscript> {
  const onDevice = options.onDevice ?? true;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const args = ['transcribe', file, locale, '--timeout', String(Math.ceil(timeoutMs / 1000))];
  if (onDevice) args.push('--on-device');

  const parsed = await runHelper(args, timeoutMs + 5_000);
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  log.debug('macOS speech recognition finished', { locale, chars: text.length, confidence });
  return { text, confidence, locale };
}
