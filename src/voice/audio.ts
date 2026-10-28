/**
 * Getting inbound voice audio into something a recogniser will open.
 *
 * Telegram voice notes are Ogg/Opus. AVFoundation — which is what
 * `SFSpeechURLRecognitionRequest` reads with — does not open Ogg at all, so handing it the
 * inbound file straight from the inbox fails with a decode error that says nothing about the
 * container. Every backend therefore gets a 16 kHz mono WAV, which is both what the on-device
 * recogniser wants and comfortably inside the transcription API's size limits: a minute of
 * speech is about 1.9 MB, against 64 kB of Opus, and that trade is worth it for one code path
 * that cannot silently be handed a format one backend reads and the other does not.
 *
 * ffmpeg is resolved through the same `resolveCliPath` the other builtins use, because launchd
 * hands this process a PATH with no Homebrew in it.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCliPath } from '../host-mcp/builtins/shared/executables.js';

const execFileAsync = promisify(execFile);

/** 16 kHz mono is what the on-device recogniser resamples to anyway. */
const TARGET_RATE = 16_000;

export class AudioUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioUnavailable';
  }
}

/**
 * Whether this attachment is someone *speaking to Luna*, as opposed to an audio file they sent it.
 *
 * The difference matters more than it looks. A held-to-record note is a way of typing: it becomes
 * the message and the audio is worth nothing afterwards. An audio file is content — something to
 * play, file, or hand to a tool — and turning it into the sender's words would put things in
 * their mouth they never said.
 *
 * Telegram draws the line for us, though not where the names suggest. Its adapter maps **both**
 * `raw.voice` and `raw.audio` to `type: 'audio'`; what separates them is the filename. A voice
 * note has none — there is no file, only a recording — while every uploaded audio file carries
 * `file_name`, and an audio file sent as a document arrives as `type: 'file'` instead. So the
 * discriminator is "audio with nothing to call it", which is exactly what a recording is.
 *
 * `type: 'voice'` is honoured too for any adapter that labels it directly.
 */
export function isVoiceMessage(att: { type?: unknown; mimeType?: unknown; name?: unknown }): boolean {
  const type = typeof att.type === 'string' ? att.type.toLowerCase() : '';
  if (type === 'voice') return true;
  if (type !== 'audio') return false;

  // A filename means the sender chose a file rather than held a button.
  const name = typeof att.name === 'string' ? att.name.trim() : '';
  if (name !== '') return false;

  // Adapters that set no MIME at all still reach here as bare `audio`, which is the case this is
  // for; anything that does declare one has to declare audio.
  const mime = typeof att.mimeType === 'string' ? att.mimeType.split(';')[0]!.trim().toLowerCase() : '';
  return mime === '' || mime.startsWith('audio/');
}

function ffmpeg(): string {
  const bin = resolveCliPath('ffmpeg');
  if (!bin) {
    throw new AudioUnavailable('ffmpeg is not installed — run `brew install ffmpeg` to transcribe voice messages');
  }
  return bin;
}

/** Seconds of audio, or null when ffprobe cannot tell us. Used to refuse a file before decoding it. */
export async function audioDurationSeconds(file: string): Promise<number | null> {
  const bin = resolveCliPath('ffprobe');
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(
      bin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { timeout: 15_000 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

export interface PreparedAudio {
  /** 16 kHz mono WAV, in a directory of its own. */
  path: string;
  /** Removes the temporary directory. Always call it; it never throws. */
  cleanup: () => void;
}

/**
 * Decode `input` to 16 kHz mono WAV in a fresh temp directory.
 *
 * Writing into a private `mkdtemp` rather than beside the source keeps this off the session
 * inbox, which is mounted into the container — a transcode artefact is not something the agent
 * should find next to the original.
 */
export async function prepareForRecognition(input: string, timeoutMs = 60_000): Promise<PreparedAudio> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-voice-'));
  const output = path.join(dir, 'audio.wav');
  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp directory we cannot remove is not worth failing a message over */
    }
  };

  try {
    await execFileAsync(
      ffmpeg(),
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        input,
        '-ac',
        '1',
        '-ar',
        String(TARGET_RATE),
        '-c:a',
        'pcm_s16le',
        '-y',
        output,
      ],
      { timeout: timeoutMs },
    );
  } catch (err) {
    cleanup();
    const detail = err instanceof Error ? err.message : String(err);
    throw new AudioUnavailable(`could not decode the voice message: ${detail}`);
  }

  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    cleanup();
    throw new AudioUnavailable('the voice message decoded to an empty file');
  }

  return { path: output, cleanup };
}
