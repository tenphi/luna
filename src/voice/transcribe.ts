/**
 * Which recogniser hears a voice message, and why.
 *
 * Two backends, and the choice between them is made **per install, from the configured
 * languages** — not per message from a confidence score.
 *
 * That is the important decision in this file, so here is the reasoning. Apple's on-device
 * recogniser only has a locale if macOS downloaded an asset for it, and on this machine
 * `en-US` has one while `ru-RU` does not (`No Assistant asset for language ru-RU`). Recognising
 * Russian would mean sending the audio to Apple's servers, which is not something a personal
 * assistant should do without being asked. The tempting alternative — run the English recogniser
 * and fall back when it looks unsure — does not work: fed Russian speech it returns confident
 * English-shaped nonsense, and on-device results report a confidence of 0 for every segment
 * regardless, so there is no signal to route on.
 *
 * So `auto` asks one question with a real answer: can every configured language be recognised on
 * this Mac, on-device? All of them → macOS, and voice notes cost nothing and never leave the
 * machine. Any of them missing → the model, which identifies the language itself. The decision is
 * logged once per resolution so the behaviour is inspectable rather than inferred.
 */
import { loadLunaConfig } from '../config/loader.js';
import { log } from '../log.js';
import { audioDurationSeconds, AudioUnavailable, prepareForRecognition } from './audio.js';
import { probeSpeech, SpeechUnavailable, transcribeWithMacos } from './macos.js';
import { transcribeWithModel, TranscriptionModelUnavailable } from './model.js';

export type VoiceBackend = 'macos' | 'model';

export interface VoiceSettings {
  enabled: boolean;
  backend: 'auto' | 'macos' | 'model';
  languages: string[];
  maxDurationSec: number;
  deadlineMs: number;
}

const DEFAULTS: VoiceSettings = {
  enabled: true,
  backend: 'auto',
  languages: ['en-US'],
  maxDurationSec: 600,
  deadlineMs: 120_000,
};

export function voiceSettings(cfg = loadLunaConfig()): VoiceSettings {
  const voice = cfg.voice ?? {};
  const languages = (voice.languages ?? DEFAULTS.languages).map((l) => l.trim()).filter(Boolean);
  return {
    enabled: voice.enabled ?? DEFAULTS.enabled,
    backend: voice.backend ?? DEFAULTS.backend,
    languages: languages.length > 0 ? languages : DEFAULTS.languages,
    maxDurationSec: voice.maxDurationSec ?? DEFAULTS.maxDurationSec,
    deadlineMs: voice.deadlineMs ?? DEFAULTS.deadlineMs,
  };
}

export interface BackendChoice {
  backend: VoiceBackend;
  /** The locale macOS will be asked for. Empty for the model backend, which detects it. */
  locale: string;
  reason: string;
}

/**
 * Resolve `auto`, or explain why an explicit choice cannot be honoured.
 *
 * Cached for the life of the process: the answer depends on installed assets and a TCC grant,
 * neither of which changes between two voice notes, and probing spawns a helper.
 */
let cached: { key: string; choice: BackendChoice } | null = null;

export function resetBackendCache(): void {
  cached = null;
}

export async function selectBackend(settings: VoiceSettings): Promise<BackendChoice> {
  const key = `${settings.backend}:${settings.languages.join(',')}`;
  if (cached?.key === key) return cached.choice;

  const choice = await resolveBackend(settings);
  cached = { key, choice };
  log.info('voice transcription backend selected', {
    backend: choice.backend,
    ...(choice.locale ? { locale: choice.locale } : {}),
    reason: choice.reason,
  });
  return choice;
}

async function resolveBackend(settings: VoiceSettings): Promise<BackendChoice> {
  if (settings.backend === 'model') {
    return { backend: 'model', locale: '', reason: 'configured' };
  }

  let probe;
  try {
    probe = await probeSpeech(settings.languages);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (settings.backend === 'macos') throw new SpeechUnavailable(reason);
    return { backend: 'model', locale: '', reason: `macOS speech unavailable: ${reason}` };
  }

  const byLocale = new Map(probe.locales.map((entry) => [entry.locale.toLowerCase(), entry]));
  const missing = settings.languages.filter((language) => {
    const entry = byLocale.get(language.replace(/_/g, '-').toLowerCase());
    return !entry?.onDevice;
  });

  // Missing assets are reported ahead of a missing grant, because only one of the two is worth
  // acting on. Told "speech recognition is notDetermined — run the grant script", an operator who
  // has ru-RU configured would go and grant it and land in exactly the same place: the asset is
  // what decides, and no permission brings it into existence.
  if (missing.length > 0) {
    const reason = `no on-device asset for ${missing.join(', ')}`;
    if (settings.backend === 'macos') throw new SpeechUnavailable(`${reason} — macOS cannot transcribe it on-device`);
    return { backend: 'model', locale: '', reason };
  }

  if (probe.authorization !== 'authorized') {
    const reason = `macOS speech recognition is ${probe.authorization} — run scripts/apple-grant-speech.command`;
    if (settings.backend === 'macos') throw new SpeechUnavailable(reason);
    return { backend: 'model', locale: '', reason };
  }

  return { backend: 'macos', locale: settings.languages[0]!, reason: 'every configured language is on-device' };
}

export interface Transcript {
  text: string;
  backend: VoiceBackend;
  durationSec: number | null;
}

export class VoiceTranscriptionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceTranscriptionFailed';
  }
}

/**
 * Transcribe one audio file. Throws `VoiceTranscriptionFailed` with something a person could act
 * on — the caller turns that into a note on the message rather than swallowing it, because a
 * voice note that silently became nothing is worse than one that says why.
 */
export async function transcribeAudio(file: string, settings = voiceSettings()): Promise<Transcript> {
  const duration = await audioDurationSeconds(file);
  if (duration !== null && duration > settings.maxDurationSec) {
    throw new VoiceTranscriptionFailed(
      `the voice message is ${Math.round(duration)}s, over the ${settings.maxDurationSec}s limit`,
    );
  }

  let prepared;
  try {
    prepared = await prepareForRecognition(file, settings.deadlineMs);
  } catch (err) {
    throw new VoiceTranscriptionFailed(err instanceof AudioUnavailable ? err.message : String(err));
  }

  try {
    const choice = await selectBackend(settings);
    const text =
      choice.backend === 'macos'
        ? (await transcribeWithMacos(prepared.path, choice.locale, { timeoutMs: settings.deadlineMs })).text
        : await transcribeWithModel(prepared.path, { languages: settings.languages, timeoutMs: settings.deadlineMs });

    if (!text) throw new VoiceTranscriptionFailed('the voice message came back empty — no speech was recognised');
    return { text, backend: choice.backend, durationSec: duration };
  } catch (err) {
    if (err instanceof VoiceTranscriptionFailed) throw err;
    if (err instanceof SpeechUnavailable || err instanceof TranscriptionModelUnavailable) {
      throw new VoiceTranscriptionFailed(err.message);
    }
    throw new VoiceTranscriptionFailed(err instanceof Error ? err.message : String(err));
  } finally {
    prepared.cleanup();
  }
}
