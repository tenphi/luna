import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('./transcribe.js', async () => {
  const actual = await vi.importActual<typeof import('./transcribe.js')>('./transcribe.js');
  return { ...actual, transcribeAudio: state.transcribe };
});

import { transcribeInboundContent } from './inbound.js';
import { VoiceTranscriptionFailed, type VoiceSettings } from './transcribe.js';

const settings: VoiceSettings = {
  enabled: true,
  backend: 'auto',
  languages: ['en-US'],
  maxDurationSec: 600,
  deadlineMs: 120_000,
};

/** What Telegram's adapter produces for a held-to-record note: audio class, no filename. */
const voiceNote = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    text: '',
    attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.from('fake-opus').toString('base64') }],
    ...extra,
  });

const parse = (content: string) =>
  JSON.parse(content) as { text?: string; attachments?: Array<Record<string, unknown>> };

beforeEach(() => {
  state.transcribe.mockReset();
  state.transcribe.mockResolvedValue({ text: 'remind me to buy milk', backend: 'macos', durationSec: 3 });
});

describe('hearing an inbound voice message', () => {
  it('makes the spoken words the message text, so everything downstream reads speech as typing', async () => {
    const out = await transcribeInboundContent(voiceNote(), settings);

    // The point of the whole feature: `text` is what the router matches engagement on, what the
    // memory digest learns from, and what the agent is handed.
    expect(parse(out).text).toBe('remind me to buy milk');
  });

  it('drops the recording, so the agent is never handed an .ogg it cannot read', async () => {
    // Speaking is a way of typing. Once the words are the message there is no file involved, and
    // leaving one would stage it into the container and invite an extraction attempt on Opus.
    expect(parse(await transcribeInboundContent(voiceNote(), settings)).attachments).toEqual([]);
  });

  it('keeps the recording when it could not be read — then it is the only copy of what was said', async () => {
    state.transcribe.mockRejectedValue(new VoiceTranscriptionFailed('no speech was recognised'));

    const attachments = parse(await transcribeInboundContent(voiceNote(), settings)).attachments;

    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.data).toBeTypeOf('string');
  });

  it('leaves an audio file alone — it is content to keep, not something the sender said', async () => {
    // The same "audio" media class; the filename is the whole difference. Transcribing it would
    // put its contents in the sender's mouth, and hiding it would lose a file they meant to send.
    const file = JSON.stringify({
      text: 'file this',
      attachments: [{ type: 'audio', mimeType: 'audio/mpeg', name: 'interview.mp3', data: 'AAAA' }],
    });

    expect(await transcribeInboundContent(file, settings)).toBe(file);
    expect(state.transcribe).not.toHaveBeenCalled();
  });

  it('transcribes the voice note in a message that also carries an audio file, keeping only the file', async () => {
    const mixed = JSON.stringify({
      text: '',
      attachments: [
        { type: 'audio', mimeType: 'audio/ogg', data: 'AAAA' },
        { type: 'audio', mimeType: 'audio/mpeg', name: 'interview.mp3', data: 'BBBB' },
      ],
    });

    const out = parse(await transcribeInboundContent(mixed, settings));

    expect(out.text).toBe('remind me to buy milk');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments?.[0]?.name).toBe('interview.mp3');
  });

  it('keeps a caption sent with the audio, ahead of what was spoken', async () => {
    const out = await transcribeInboundContent(voiceNote({ text: 'about tomorrow' }), settings);

    expect(parse(out).text).toBe('about tomorrow\n\nremind me to buy milk');
  });

  it('tells the user when it could not hear them rather than delivering silence', async () => {
    // A voice note that quietly became an empty message is the failure worth avoiding: the
    // sender watches the assistant ignore them with no idea why.
    state.transcribe.mockRejectedValue(new VoiceTranscriptionFailed('no speech was recognised'));

    const out = await transcribeInboundContent(voiceNote(), settings);

    expect(parse(out).text).toContain('no speech was recognised');
    expect(parse(out).attachments?.[0]?.transcriptError).toBe('no speech was recognised');
  });

  it('transcribes every voice note in one message, in order', async () => {
    state.transcribe
      .mockResolvedValueOnce({ text: 'first thing', backend: 'macos', durationSec: 2 })
      .mockResolvedValueOnce({ text: 'second thing', backend: 'macos', durationSec: 2 });
    const two = JSON.stringify({
      text: '',
      attachments: [
        { type: 'audio', mimeType: 'audio/ogg', data: 'AAAA' },
        { type: 'audio', mimeType: 'audio/ogg', data: 'BBBB' },
      ],
    });

    expect(parse(await transcribeInboundContent(two, settings)).text).toBe('first thing\n\nsecond thing');
  });

  it('leaves messages without audio completely alone', async () => {
    const typed = JSON.stringify({ text: 'just typing' });
    const photo = JSON.stringify({ text: '', attachments: [{ type: 'photo', mimeType: 'image/jpeg', data: 'AAAA' }] });

    expect(await transcribeInboundContent(typed, settings)).toBe(typed);
    expect(await transcribeInboundContent(photo, settings)).toBe(photo);
    expect(state.transcribe).not.toHaveBeenCalled();
  });

  it('does nothing when voice is switched off', async () => {
    const content = voiceNote();

    expect(await transcribeInboundContent(content, { ...settings, enabled: false })).toBe(content);
    expect(state.transcribe).not.toHaveBeenCalled();
  });

  it('passes non-JSON content through untouched', async () => {
    expect(await transcribeInboundContent('plain text', settings)).toBe('plain text');
  });
});
