/**
 * Live reply streaming — the answer appearing as it is written.
 *
 * The container already sends the accumulated answer text to the host: the
 * provider emits `phase:'generating'` with `text` roughly every 300ms, and the
 * progress bubble deliberately ignores the prose (it shows "🐾 Typing…" and
 * nothing more, because the finished answer arrives as its own message). This
 * module picks that text up and shows it live on channels that can display
 * growing text without notifying — today that means Telegram live drafts.
 *
 * Nothing here is durable. A dropped update costs a preview frame; the real
 * message is delivered by the ordinary outbound path either way, and on
 * Telegram its arrival is also what clears the draft. So every failure mode
 * degrades to "no preview, normal answer".
 *
 * Three things drive the shape of this module:
 *
 * **Throttling is mandatory.** Telegram allows 20 draft calls / 5s and 40 / 30s
 * per peer; the provider emits ~3.3/s. Updates are coalesced latest-wins and
 * sent at most once per `MIN_INTERVAL_MS`, so a long answer stays inside the
 * sustained budget no matter how fast the model streams.
 *
 * **Prose arrives in segments.** Text written before a tool call is delivered
 * as its own message mid-turn, and the next model stream starts accumulating
 * from empty. A new segment must therefore get its own draft rather than
 * appearing to rewrite the previous one — detected by the incoming text no
 * longer extending what we have seen.
 *
 * **Never block the status path.** `note` is synchronous and returns
 * immediately; sending happens on a single-flight timer. Awaiting a Telegram
 * call inside the status write would slow the container's status flush loop,
 * which is on the same path that keeps the turn's liveness honest.
 */
import { log } from '../log.js';
import { buildProgressSink } from './status-events.js';

/**
 * Minimum gap between draft updates. 1s keeps us at 5 calls per 5s and 30 per
 * 30s — comfortably inside both Telegram windows, with room for the occasional
 * forced flush.
 */
const MIN_INTERVAL_MS = 1000;

/** Telegram's message/draft ceiling. A longer preview is truncated, not split. */
const MAX_CHARS = 4096;

interface Destination {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

interface StreamState {
  dest: Destination;
  /** Draft id in flight. A new prose segment mints a new one. */
  draftId: number;
  /** Raw accumulated text last seen, for segment-boundary detection. */
  seenText: string;
  /** Rendered text last successfully sent, to skip no-op updates. */
  sentText: string;
  sentAt: number;
  /** Latest rendered text not yet sent (latest-wins coalescing). */
  pending: string | null;
  timer: NodeJS.Timeout | null;
  sending: boolean;
  /**
   * Set once the channel says it cannot stream here (a group chat, an API
   * refusal). The turn keeps running; it just gets no preview.
   */
  disabled: boolean;
}

const streams = new Map<string, StreamState>();

/** Draft ids are per-peer, but a process-wide counter is simpler and just as unique. */
let nextDraftId = 0;
function mintDraftId(): number {
  // Bot API draft_id is a positive int32.
  nextDraftId = nextDraftId >= 2_147_483_647 ? 1 : nextDraftId + 1;
  return nextDraftId;
}

/**
 * The preview text for a given accumulation of the answer.
 *
 * Deliberately verbatim — markdown markers and all. The preview MUST be
 * prefix-stable: the client fades in characters that were *added*, so any
 * transform that removes a character it already showed makes the whole string
 * re-animate and the chat jump. Stripping markdown does exactly that —
 * `**status bubble` renders with visible asterisks until the closing pair
 * arrives and then loses them, which measured 6 prefix breaks in one short
 * answer. Flattening also destroys structure, running list items and paragraphs
 * together, because it targets a one-line summary rather than a readable body.
 *
 * So the preview shows raw markers for a second and the real message that
 * replaces it carries the formatting. Only trailing whitespace is trimmed,
 * which cannot break the prefix of a growing string.
 */
function renderPreview(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed;
}

/**
 * Record the newest accumulated answer text for a session.
 *
 * Safe to call at the provider's full emission rate: it only updates in-memory
 * state and arms a timer.
 */
export function noteReplyText(sessionId: string, dest: Destination, text: string): void {
  const existing = streams.get(sessionId);

  // A new prose segment (the previous one was delivered as its own message and
  // the model started a fresh stream) no longer extends what we have seen.
  const isNewSegment = existing !== undefined && !text.startsWith(existing.seenText);

  let state = existing;
  if (!state || isNewSegment) {
    if (state?.timer) clearTimeout(state.timer);
    state = {
      dest,
      draftId: mintDraftId(),
      seenText: '',
      sentText: '',
      sentAt: 0,
      pending: null,
      timer: null,
      sending: false,
      // A channel that refused once will refuse again this turn.
      disabled: state?.disabled ?? false,
    };
    streams.set(sessionId, state);
  }
  if (state.disabled) return;

  state.dest = dest;
  state.seenText = text;

  const preview = renderPreview(text);
  if (!preview || preview === state.sentText) return;
  state.pending = preview;
  schedule(sessionId, state);
}

/** Arm the single-flight timer honouring MIN_INTERVAL_MS since the last send. */
function schedule(sessionId: string, state: StreamState): void {
  if (state.timer || state.sending) return;
  const wait = Math.max(0, state.sentAt + MIN_INTERVAL_MS - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    void flush(sessionId, state);
  }, wait);
}

async function flush(sessionId: string, state: StreamState): Promise<void> {
  if (state.sending || state.disabled) return;
  const text = state.pending;
  state.pending = null;
  if (!text || text === state.sentText) return;

  state.sending = true;
  try {
    const sink = buildProgressSink(state.dest.channelType, state.dest.platformId, state.dest.threadId);
    if (!sink?.streamReply) {
      state.disabled = true;
      return;
    }
    await sink.streamReply(state.draftId, text);
    state.sentText = text;
    state.sentAt = Date.now();
  } catch (err) {
    // The channel cannot stream here. Stop for this turn; the answer is
    // unaffected, and the next turn gets a fresh state to try again.
    state.disabled = true;
    log.debug('Reply streaming unavailable for this destination', { sessionId, err });
  } finally {
    state.sending = false;
    // Text that arrived while this update was in flight.
    if (state.pending && !state.disabled) schedule(sessionId, state);
  }
}

/**
 * Drop the session's stream state at end of turn.
 *
 * The draft is deliberately left alone: `phase:'done'` lands just before the
 * answer is written, and clearing here would blank the preview a beat before
 * the real message replaces it — a visible flicker. An unreplaced draft expires
 * on its own.
 */
export function endReplyStream(sessionId: string): void {
  const state = streams.get(sessionId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  streams.delete(sessionId);
}
