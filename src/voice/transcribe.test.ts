import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./macos.js', async () => {
  const actual = await vi.importActual<typeof import('./macos.js')>('./macos.js');
  return { ...actual, probeSpeech: state.probe };
});

import { SpeechUnavailable } from './macos.js';
import { isVoiceMessage } from './audio.js';
import { resetBackendCache, selectBackend, type VoiceSettings } from './transcribe.js';

const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({
  enabled: true,
  backend: 'auto',
  languages: ['en-US'],
  maxDurationSec: 600,
  deadlineMs: 120_000,
  ...over,
});

const locale = (id: string, onDevice: boolean) => ({ locale: id, supported: true, onDevice, available: true });

beforeEach(() => {
  resetBackendCache();
  state.probe.mockReset();
});

describe('choosing which recogniser hears a voice message', () => {
  it('uses macOS when every configured language has an on-device asset', async () => {
    state.probe.mockResolvedValue({ authorization: 'authorized', locales: [locale('en-US', true)] });

    expect(await selectBackend(settings())).toMatchObject({ backend: 'macos', locale: 'en-US' });
  });

  it('uses the model when any configured language has no on-device asset', async () => {
    // The case that motivated the whole design: macOS reports ru-RU as "supported" but has no
    // downloaded asset for it, so recognising it would mean uploading the audio to Apple. The
    // alternative — run the English recogniser and fall back when it looks unsure — cannot work,
    // because on-device results report confidence 0 and Russian speech comes back as confident
    // English-shaped nonsense. So the choice is made from assets, not from scores.
    state.probe.mockResolvedValue({
      authorization: 'authorized',
      locales: [locale('en-US', true), locale('ru-RU', false)],
    });

    const choice = await selectBackend(settings({ languages: ['en-US', 'ru-RU'] }));

    expect(choice.backend).toBe('model');
    expect(choice.reason).toContain('ru-RU');
  });

  it('uses the model when speech recognition was never granted', async () => {
    state.probe.mockResolvedValue({ authorization: 'notDetermined', locales: [locale('en-US', true)] });

    const choice = await selectBackend(settings());

    expect(choice.backend).toBe('model');
    expect(choice.reason).toContain('notDetermined');
  });

  it('blames the missing asset, not the missing grant, when both are true', async () => {
    // Only one of the two is worth acting on. Told to run the grant script, an operator with
    // ru-RU configured would grant it and land in exactly the same place — the asset decides,
    // and no permission brings one into existence.
    state.probe.mockResolvedValue({
      authorization: 'notDetermined',
      locales: [locale('en-US', true), locale('ru-RU', false)],
    });

    const choice = await selectBackend(settings({ languages: ['en-US', 'ru-RU'] }));

    expect(choice.reason).toContain('ru-RU');
    expect(choice.reason).not.toContain('notDetermined');
  });

  it('uses the model when the helper itself cannot run', async () => {
    state.probe.mockRejectedValue(new SpeechUnavailable('the speech helper is missing'));

    expect((await selectBackend(settings())).backend).toBe('model');
  });

  it('refuses rather than silently uploading audio when macOS was demanded explicitly', async () => {
    state.probe.mockResolvedValue({ authorization: 'authorized', locales: [locale('ru-RU', false)] });

    await expect(selectBackend(settings({ backend: 'macos', languages: ['ru-RU'] }))).rejects.toThrow(/on-device/);
  });

  it('never probes when the model backend was chosen outright', async () => {
    expect((await selectBackend(settings({ backend: 'model' }))).backend).toBe('model');
    expect(state.probe).not.toHaveBeenCalled();
  });

  it('probes once and reuses the answer — assets and grants do not change between two notes', async () => {
    state.probe.mockResolvedValue({ authorization: 'authorized', locales: [locale('en-US', true)] });

    await selectBackend(settings());
    await selectBackend(settings());

    expect(state.probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the configured languages change', async () => {
    state.probe.mockResolvedValue({ authorization: 'authorized', locales: [locale('en-US', true)] });

    await selectBackend(settings());
    await selectBackend(settings({ languages: ['en-GB'] }));

    expect(state.probe).toHaveBeenCalledTimes(2);
  });
});

describe('telling a voice message apart from an audio file', () => {
  it('reads a held-to-record note as speech', () => {
    // What Telegram's adapter actually produces for `raw.voice`: type "audio", an Ogg MIME, and
    // no filename — because there is no file, only a recording.
    expect(isVoiceMessage({ type: 'audio', mimeType: 'audio/ogg' })).toBe(true);
    // An adapter that labels it outright is taken at its word.
    expect(isVoiceMessage({ type: 'voice' })).toBe(true);
  });

  it('leaves an audio file alone — it is content, not something the sender said', () => {
    // `raw.audio` is the same "audio" media class; the filename is the whole difference, and
    // transcribing it would put words in the sender's mouth they never spoke.
    expect(isVoiceMessage({ type: 'audio', mimeType: 'audio/mpeg', name: 'interview.mp3' })).toBe(false);
    expect(isVoiceMessage({ type: 'audio', mimeType: 'audio/ogg', name: 'song.ogg' })).toBe(false);
    // An audio file sent as a document does not even arrive as the audio class.
    expect(isVoiceMessage({ type: 'file', name: 'note.ogg', mimeType: 'audio/ogg' })).toBe(false);
  });

  it('ignores everything that is not audio at all', () => {
    expect(isVoiceMessage({ type: 'photo', mimeType: 'image/jpeg' })).toBe(false);
    expect(isVoiceMessage({ type: 'file', name: 'lease.pdf' })).toBe(false);
    expect(isVoiceMessage({})).toBe(false);
  });
});
