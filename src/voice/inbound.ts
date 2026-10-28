/**
 * Turning a received voice message into what the user said.
 *
 * This runs on the host, in the router, before the message is written to any session — which is
 * the only place it can run and still mean something. By the time the agent sees a turn, the
 * text is the text: engagement patterns match it, the memory digest learns from it, and the
 * container never has to know that a microphone was involved. A voice note whose transcript
 * arrived later would be a message the agent already answered.
 *
 * A voice message and an audio file are not the same thing, and are not treated alike. Speaking
 * is a way of typing: the note becomes the text and the recording is discarded, so the agent is
 * never handed an .ogg whose entire content is already the message above it. An audio file is
 * content the sender means to keep — it is left exactly as it arrived.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log } from '../log.js';
import { isVoiceMessage } from './audio.js';
import { transcribeAudio, voiceSettings, VoiceTranscriptionFailed, type VoiceSettings } from './transcribe.js';

/** Extension for the temp file we hand ffmpeg, so it has a hint about the container format. */
function extensionFor(att: Record<string, unknown>): string {
  const name = typeof att.name === 'string' ? att.name : '';
  const fromName = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (fromName && /^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const mime = typeof att.mimeType === 'string' ? att.mimeType.split(';')[0]!.trim().toLowerCase() : '';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a') return 'm4a';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  // Telegram's voice notes, and the only format that actually needs the transcode.
  return 'ogg';
}

/**
 * One voice attachment's base64 payload, on disk long enough to be decoded.
 *
 * Written to a private temp directory rather than the session inbox: the inbox is mounted into
 * the container, and the host's scratch copy of audio it is still deciding about does not belong
 * somewhere the agent can watch it appear.
 */
async function transcribeAttachment(att: Record<string, unknown>, settings: VoiceSettings): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-voice-in-'));
  const file = path.join(dir, `audio.${extensionFor(att)}`);
  try {
    fs.writeFileSync(file, Buffer.from(att.data as string, 'base64'));
    const transcript = await transcribeAudio(file, settings);
    log.info('voice message transcribed', {
      backend: transcript.backend,
      chars: transcript.text.length,
      ...(transcript.durationSec !== null ? { durationSec: Math.round(transcript.durationSec) } : {}),
    });
    return transcript.text;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Replace inbound content's `text` with what was spoken, and drop the recording.
 *
 * **A transcribed voice message stops being an attachment.** Speaking is a way of typing, so what
 * reaches the agent is a message someone said — not a message with an .ogg stapled to it. Leaving
 * the file there would stage it into the container inbox and put a line in the prompt inviting an
 * extraction attempt on Opus, for audio whose only content is already the text above it.
 *
 * An audio *file* is untouched by all of this: it never gets here (see `isVoiceMessage`), it
 * stages as normal, and the agent sees it as the file it is.
 *
 * The recording is kept in exactly one case — transcription failed. Then it is the only copy of
 * what the sender said, and discarding it would turn a recoverable failure into a lost message.
 *
 * Returns the content unchanged when there is nothing to do, so the router can call it on every
 * message without branching. A failure is reported *in the text* rather than thrown: the
 * alternative is dropping the turn, and someone who just spoke into their phone deserves to be
 * told the transcription failed rather than watching the assistant ignore them.
 */
export async function transcribeInboundContent(content: string, settings = voiceSettings()): Promise<string> {
  if (!settings.enabled) return content;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }

  const attachments = parsed.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return content;

  const voices = (attachments as Array<Record<string, unknown>>).filter(
    (att) => typeof att.data === 'string' && isVoiceMessage(att),
  );
  if (voices.length === 0) return content;

  const spoken: string[] = [];
  const failures: string[] = [];
  const transcribed = new Set<Record<string, unknown>>();

  for (const att of voices) {
    try {
      const text = await transcribeAttachment(att, settings);
      transcribed.add(att);
      spoken.push(text);
    } catch (err) {
      const reason = err instanceof VoiceTranscriptionFailed ? err.message : String(err);
      att.transcriptError = reason;
      failures.push(reason);
      log.warn('voice message could not be transcribed', { reason });
    }
  }

  if (spoken.length === 0 && failures.length === 0) return content;

  // The recording has become the text; only what could not be read stays behind.
  parsed.attachments = (attachments as Array<Record<string, unknown>>).filter((att) => !transcribed.has(att));

  // A caption sent alongside the audio is the user's own typing and outranks nothing — both are
  // things they said, in the order they said them.
  const caption = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const parts = [caption, ...spoken].filter(Boolean);
  if (failures.length > 0) {
    parts.push(`[a voice message could not be transcribed: ${failures.join('; ')}]`);
  }
  parsed.text = parts.join('\n\n');

  return JSON.stringify(parsed);
}
