/**
 * ProgressController — per-session host-side live status message.
 *
 * Listens to `kind:'status'` rows from the container, maintains a list of
 * StatusLines, and drives a single edited message on the user's channel.
 *
 * Reveal thresholds (measured from T0 = the user's triggering inbound message):
 *   - Thinking-only and done < 5s  → nothing shown at all, just the answer.
 *   - Tool call seen               → process message shown immediately.
 *   - Pure-thinking and ≥ 5s       → process message created/shown.
 *
 * On tool turns, phase:'generating' switches the active line to Typing…
 * (prose is never shown in the bubble). The message collapses to the done
 * summary only on phase:'done' — collapsing earlier left a stale "✅ Done"
 * while the model was still writing (often for many seconds of <internal>
 * reasoning) with no live signal.
 *
 * Once shown, on finalize the message is edited to the compact done summary.
 *
 * Edit throttle: the visible text is only pushed to the platform if it changed
 * AND at least THROTTLE_MS elapsed since the last successful edit.
 *
 * The ticker runs every TICK_MS updating elapsed counters; actual API calls
 * are throttled separately. Errors in send/edit are swallowed (best-effort).
 */

import { log } from '../log.js';
import { adapterRateLimitRetryAfterSec } from '../channels/adapter-errors.js';
import { noteAgentMemoryWriteFromTool } from '../memory/digest.js';
import { summarizeTool } from './tool-summary.js';
import {
  type StatusLine,
  renderLive,
  renderDone,
  renderCliDone,
  renderCliInterrupted,
  renderInterrupted,
} from './render.js';

const TICK_MS = 1000;
const THROTTLE_MS = 1000;

function isBenignEditError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('message is not modified');
}

/** Show the process message after this long when no tools have run yet. */
const REVEAL_THINKING_ONLY_MS = 5000;

export interface StatusEvent {
  phase: string;
  effort?: string;
  name?: string;
  args?: Record<string, unknown>;
  message?: string;
  text?: string;
  partial?: boolean;
  index?: number;
}

/** Callbacks the controller uses to talk to the user's channel. */
export interface ProgressSink {
  /**
   * Send the initial process message. Returns the platform message ID
   * (needed for future edits), or undefined if sending is not supported.
   */
  sendStatus(text: string): Promise<string | undefined>;
  /**
   * Edit the previously sent process message. Only called after sendStatus
   * returned a non-empty messageId.
   */
  editStatus(messageId: string, text: string): Promise<void>;
  /**
   * Delete the previously sent process message. Used to remove an orphaned
   * thinking-only bubble when a new turn supersedes it. Optional: channels that
   * cannot delete (e.g. CLI) simply omit it.
   */
  deleteStatus?(messageId: string): Promise<void>;
  /**
   * Show the answer as it is being written, keyed by `streamId` so successive
   * calls replace the same preview. Separate from the status bubble: this is the
   * reply itself, not progress about it, and it is superseded by the real
   * message rather than edited into one.
   *
   * Optional — omitted by channels with no way to show growing text quietly.
   * Throwing means "not possible here"; the caller stops for the turn.
   * See src/progress/reply-stream.ts.
   */
  streamReply?(streamId: number, text: string): Promise<void>;
  /**
   * Special sink for the CLI channel: push the current lines array directly
   * (the CLI client renders them itself via ANSI).
   */
  pushCliStatus?(lines: string[]): void;
  /** True if this is a CLI channel (uses pushCliStatus instead of send/edit). */
  isCli: boolean;
}

interface SessionState {
  sessionId: string;
  reasoningEffort?: string;
  lines: StatusLine[];
  /** OpenAI stream tool index → line for the current model stream only. */
  activeToolByIndex: Map<number, StatusLine>;
  t0: number;
  seenTool: boolean;
  messageId: string | undefined;
  lastSentText: string;
  lastEditAt: number;
  finalized: boolean;
  /** Locked until this timestamp if we hit a rate limit. */
  rateLimitUntil?: number;
  ticker: NodeJS.Timeout;
  sink: ProgressSink;
  /** Destination the process bubble was sent to. */
  channelType?: string;
  platformId?: string;
  threadId?: string | null;
  /** Triggering inbound message id — the per-turn anchor. A status row whose
   *  anchor differs means a new user turn started; the old bubble is closed
   *  and a fresh one begins so the previous message never "jumps" to the new
   *  answer. */
  anchor?: string | null;
}

const sessions = new Map<string, SessionState>();

/** The bit of a live bubble worth surviving a host restart. See persistence.ts. */
export interface LiveBubbleRecord {
  messageId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Turn start (the triggering inbound message's timestamp). */
  t0: number;
  /** Triggering inbound message id. */
  anchor: string | null;
}

/**
 * Optional durable mirror of the on-screen bubble.
 *
 * Everything else in this controller is in-memory, which is correct for a
 * message that only matters while it's ticking — except across a host restart,
 * where the platform keeps rendering the last text we wrote forever. The
 * record is what lets boot find "🤔 Thinking… 12s" from an hour ago and close
 * it. Best-effort by design: never let bookkeeping break the live UI.
 */
export interface ProgressPersistence {
  save(sessionId: string, record: LiveBubbleRecord): void;
  clear(sessionId: string): void;
}

let persistence: ProgressPersistence | null = null;

export function setProgressPersistence(p: ProgressPersistence | null): void {
  persistence = p;
}

/** Drop the session and its durable record together — they always end as a pair. */
function endSession(sessionId: string): void {
  sessions.delete(sessionId);
  try {
    persistence?.clear(sessionId);
  } catch (err) {
    log.warn('ProgressController: failed to clear persisted bubble', { sessionId, err });
  }
}

function recordLiveBubble(sessionId: string, state: SessionState): void {
  if (!persistence || !state.messageId || !state.channelType || !state.platformId) return;
  try {
    persistence.save(sessionId, {
      messageId: state.messageId,
      channelType: state.channelType,
      platformId: state.platformId,
      threadId: state.threadId ?? null,
      t0: state.t0,
      anchor: state.anchor ?? null,
    });
  } catch (err) {
    log.warn('ProgressController: failed to persist bubble', { sessionId, err });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pushLine(
  state: SessionState,
  kind: StatusLine['kind'],
  emoji: string,
  label: string,
  summary: string,
  extra?: Pick<StatusLine, 'toolIndex' | 'partial' | 'endedAt'>,
): void {
  const now = Date.now();
  if (state.lines.length > 0) {
    const last = state.lines[state.lines.length - 1]!;
    if (last.endedAt === undefined) {
      last.endedAt = now;
    }
  }
  state.lines.push({
    kind,
    emoji,
    label,
    summary,
    startedAt: now,
    ...extra,
  });
}

function freezeActiveLine(state: SessionState): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.endedAt === undefined) {
    last.endedAt = Date.now();
  }
}

function freezeActiveForTool(state: SessionState): void {
  // Thinking + generating are transient placeholders — drop them entirely when
  // a tool line takes over, so the first tool "replaces" the Thinking line
  // rather than leaving it frozen above the tool timeline.
  stripTransientLines(state);
}

/** Transient placeholders (thinking + generating) never persist in the process
 *  message — drop them whenever a real tool line or the done state takes over. */
function stripTransientLines(state: SessionState): void {
  state.lines = state.lines.filter((l) => l.kind !== 'generating' && l.kind !== 'thinking');
}

/** Coalesce: if last active line is already 'thinking', just let it keep ticking. */
function ensureThinking(state: SessionState): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === 'thinking' && last.endedAt === undefined) {
    return;
  }
  pushLine(state, 'thinking', '🤔', 'Thinking', '');
}

/** Coalesce: if last active line is already 'generating' (Typing…), keep ticking. */
function ensureGenerating(state: SessionState): void {
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === 'generating' && last.endedAt === undefined) {
    return;
  }
  // Drop Thinking placeholders; freeze completed tool lines above Typing.
  stripTransientLines(state);
  freezeActiveLine(state);
  pushLine(state, 'generating', '🐾', 'Typing', '');
}

function clearToolStream(state: SessionState): void {
  state.activeToolByIndex.clear();
}

function findToolLine(state: SessionState, toolIndex: number | undefined): StatusLine | undefined {
  if (toolIndex !== undefined) {
    return state.activeToolByIndex.get(toolIndex);
  }
  const last = state.lines[state.lines.length - 1];
  if (last && last.kind === 'tool' && (last.endedAt === undefined || last.partial)) {
    return last;
  }
  return undefined;
}

function registerToolLine(state: SessionState, toolIndex: number | undefined, line: StatusLine): void {
  if (toolIndex !== undefined) {
    state.activeToolByIndex.set(toolIndex, line);
  }
}

function computeText(state: SessionState): string {
  return renderLive(state.lines, Date.now());
}

async function maybeSend(state: SessionState, opts?: { force?: boolean }): Promise<void> {
  const text = computeText(state);
  if (!text) return;

  const now = Date.now();
  if (state.rateLimitUntil && now < state.rateLimitUntil) return;

  if (state.sink.isCli) {
    state.sink.pushCliStatus?.(renderLiveLines(state));
    state.lastSentText = text;
    state.lastEditAt = Date.now();
    return;
  }

  if (!state.messageId) {
    try {
      const id = await state.sink.sendStatus(text);
      state.messageId = id;
      state.lastSentText = text;
      state.lastEditAt = Date.now();
      recordLiveBubble(state.sessionId, state);
    } catch (err) {
      log.warn('ProgressController: failed to send initial status message', { err });
    }
    return;
  }

  const currentThrottleMs = (() => {
    const elapsed = now - state.t0;
    if (elapsed >= 20000) return 4000;
    if (elapsed >= 10000) return 2000;
    return THROTTLE_MS;
  })();

  if (!opts?.force && text === state.lastSentText) return;
  if (!opts?.force && now - state.lastEditAt < currentThrottleMs) return;
  try {
    await state.sink.editStatus(state.messageId, text);
    state.lastSentText = text;
    state.lastEditAt = now;
  } catch (err) {
    if (isBenignEditError(err)) {
      state.lastSentText = text;
      state.lastEditAt = now;
      return;
    }
    const retryAfterS = adapterRateLimitRetryAfterSec(err);
    if (retryAfterS !== null) {
      state.rateLimitUntil = now + retryAfterS * 1000;
      log.warn('ProgressController: hit adapter rate limit, locking edits', { retryAfterS });
      return;
    }
    log.warn('ProgressController: failed to edit status message', { err });
  }
}

/** Build the raw lines array for the CLI pushCliStatus callback. */
function renderLiveLines(state: SessionState): string[] {
  return renderLive(state.lines, Date.now()).split('\n');
}

function isRevealed(state: SessionState): boolean {
  if (state.seenTool) return true;
  return Date.now() - state.t0 >= REVEAL_THINKING_ONLY_MS;
}

/** Luna chat/plumbing tools — do not surface in the progress timeline. */
const LUNA_PROGRESS_HIDDEN = new Set([
  'send_message',
  'send_file',
  'edit_message',
  'schedule_task',
  'list_tasks',
  'update_task',
  'manage_skill',
]);

function isLunaPlumbingTool(name: string): boolean {
  return name.startsWith('mcp__luna__') || LUNA_PROGRESS_HIDDEN.has(name);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new session and return a handle. Called when the first `status`
 * row for this session arrives in delivery.ts.
 */
export function createProgressSession(
  sessionId: string,
  t0: number,
  sink: ProgressSink,
  dest?: { channelType?: string; platformId?: string; threadId?: string | null; anchor?: string | null },
): void {
  destroyProgressSession(sessionId);

  const state: SessionState = {
    sessionId,
    lines: [],
    activeToolByIndex: new Map(),
    t0,
    seenTool: false,
    messageId: undefined,
    lastSentText: '',
    lastEditAt: 0,
    finalized: false,
    sink,
    channelType: dest?.channelType,
    platformId: dest?.platformId,
    threadId: dest?.threadId ?? null,
    anchor: dest?.anchor ?? null,
    ticker: setInterval(() => {
      const s = sessions.get(sessionId);
      if (!s || s.finalized) return;
      if (!isRevealed(s)) return;
      void maybeSend(s);
    }, TICK_MS),
  };
  state.ticker.unref();
  sessions.set(sessionId, state);
}

/**
 * Handle a status event from the container.
 * Called by delivery.ts for every `kind:'status'` row.
 */
export async function handleStatusEvent(sessionId: string, event: StatusEvent): Promise<void> {
  // Noted even when no progress UI is active: if the agent wrote to memory itself during this
  // turn, the after-the-turn digest stands down rather than making a second pass over the same
  // conversation. It had the whole context and chose what to keep.
  if (event.phase === 'tool' && event.partial !== true) {
    noteAgentMemoryWriteFromTool(sessionId, event.name);
  }

  const state = sessions.get(sessionId);
  if (!state || state.finalized) return;

  const { phase } = event;
  const active = state;

  if (event.effort && ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'default'].includes(event.effort)) {
    active.reasoningEffort = event.effort;
  }
  if (phase === 'effort') return;

  let forceSend = false;

  if (phase === 'thinking') {
    clearToolStream(active);
    ensureThinking(active);
  } else if (phase === 'generating') {
    // Prose never lives in the process message — interim and final answer text
    // are delivered as their own chat messages by the container. After tools,
    // flip the active line to Typing… so the bubble stays live until done.
    // Thinking-only turns keep the Thinking line (answer may edit it in place).
    if (active.seenTool) {
      clearToolStream(active);
      ensureGenerating(active);
      forceSend = true;
    } else {
      return;
    }
  } else if (phase === 'tool') {
    const name = typeof event.name === 'string' ? event.name : '';
    if (isLunaPlumbingTool(name)) return;

    active.seenTool = true;
    const toolIndex = typeof event.index === 'number' ? event.index : undefined;
    const partial = event.partial === true;
    const args = event.args ?? {};
    const { emoji, activeLabel, doneLabel, summary } = summarizeTool(name, partial ? {} : args);

    if (partial) {
      freezeActiveForTool(active);
      const existing = findToolLine(active, toolIndex);
      if (existing) {
        existing.emoji = emoji;
        existing.label = activeLabel;
        existing.doneLabel = doneLabel;
        existing.partial = true;
        if (existing.endedAt !== undefined) {
          existing.endedAt = undefined;
          existing.startedAt = Date.now();
        }
      } else {
        const line: StatusLine = {
          kind: 'tool',
          emoji,
          label: activeLabel,
          doneLabel,
          summary: '',
          startedAt: Date.now(),
          toolIndex,
          partial: true,
        };
        active.lines.push(line);
        registerToolLine(active, toolIndex, line);
      }
      forceSend = true;
    } else {
      const existing = findToolLine(active, toolIndex);
      if (existing) {
        existing.emoji = emoji;
        existing.label = activeLabel;
        existing.doneLabel = doneLabel;
        existing.summary = summary;
        existing.partial = false;
      } else {
        freezeActiveForTool(active);
        const line: StatusLine = {
          kind: 'tool',
          emoji,
          label: activeLabel,
          doneLabel,
          summary,
          startedAt: Date.now(),
          toolIndex,
          partial: false,
        };
        active.lines.push(line);
        registerToolLine(active, toolIndex, line);
      }
      forceSend = true;
    }
  } else if (phase === 'reconnecting') {
    const msg = typeof event.message === 'string' ? event.message.slice(0, 80) : 'Reconnecting';
    freezeActiveLine(active);
    pushLine(active, 'reconnecting', '🔌', 'Reconnecting', msg);
  } else if (phase === 'done') {
    await finalizeProgressSession(sessionId);
    return;
  }

  if (isRevealed(active)) {
    await maybeSend(active, forceSend ? { force: true } : undefined);
  }
}

/**
 * Finalize (called on `phase:'done'` or as a backstop from delivery when
 * processing acks clear). Collapses the process message to the done summary
 * and clears the ticker. No-op if already finalized or never revealed.
 */
export async function finalizeProgressSession(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state || state.finalized) return;
  state.finalized = true;
  clearInterval(state.ticker);

  const doneAt = Date.now();
  if (!isRevealed(state)) {
    endSession(sessionId);
    return;
  }

  if (state.sink.isCli) {
    const doneLine = renderCliDone(state.lines, state.t0, doneAt, state.reasoningEffort);
    state.sink.pushCliStatus?.([doneLine]);
    endSession(sessionId);
    return;
  }

  // Thinking-only turn (no tools ran): the "🤔 Thinking…" bubble was only a
  // transient progress placeholder — never collapse it to "✅ Done in Ns". Now
  // that the turn is finished, delete the bubble outright; the agent's answer is
  // delivered as its own message. If no bubble was shown, just drop the session.
  if (!state.seenTool) {
    if (state.messageId && state.sink.deleteStatus) {
      try {
        await state.sink.deleteStatus(state.messageId);
      } catch (err) {
        if (!isBenignEditError(err)) {
          log.warn('ProgressController: failed to delete thinking bubble on finish', { err });
        }
      }
    }
    endSession(sessionId);
    return;
  }

  if (!state.messageId && state.lines.length === 0) {
    endSession(sessionId);
    return;
  }

  const doneText = renderDone(state.lines, state.t0, doneAt, state.reasoningEffort);
  if (!state.messageId) {
    try {
      await state.sink.sendStatus(doneText);
    } catch (err) {
      log.warn('ProgressController: failed to send collapsed done message', { err });
    }
    endSession(sessionId);
    return;
  }

  try {
    await state.sink.editStatus(state.messageId, doneText);
  } catch (err) {
    if (!isBenignEditError(err)) {
      log.warn('ProgressController: failed to edit status message to done state', { err });
    }
  }
  endSession(sessionId);
}

/**
 * Close a progress session for a turn that never finished — the sweep killed a
 * silent container, the container crashed, or the retry budget ran out.
 *
 * The distinction from `finalizeProgressSession` is the whole point: that one
 * writes "✅ Done in Ns", which for an interrupted turn is a checkmark over an
 * answer the user never received.
 *
 * Only corrects a bubble that is actually on screen. When nothing was ever
 * shown there is nothing to fix, and the sweep's own chat notice — not a
 * surprise new bubble — is the right way to break the news.
 *
 * `note` describes what happens next ("retrying in 20s") when there is a next.
 */
export async function interruptProgressSession(sessionId: string, note?: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state || state.finalized) return;
  state.finalized = true;
  clearInterval(state.ticker);

  const shown = state.sink.isCli ? state.lastSentText !== '' : state.messageId !== undefined;
  if (!shown) {
    endSession(sessionId);
    return;
  }

  const at = Date.now();

  if (state.sink.isCli) {
    state.sink.pushCliStatus?.([renderCliInterrupted(state.lines, state.t0, at, note)]);
    endSession(sessionId);
    return;
  }

  try {
    await state.sink.editStatus(state.messageId!, renderInterrupted(state.lines, state.t0, at, note));
  } catch (err) {
    if (!isBenignEditError(err)) {
      log.warn('ProgressController: failed to edit status message to interrupted state', { err });
    }
  }
  endSession(sessionId);
}

/**
 * Close a still-open progress session because a NEW user turn is superseding it.
 *
 * - Tool turns collapse to their normal "✅ Done in Ns" summary (a meaningful
 *   terminal state for the previous turn).
 * - Thinking-only turns have no terminal summary — their bubble was only ever a
 *   transient "🤔 Thinking…" placeholder. It is normally deleted the moment the
 *   turn finishes; this is a backstop for a session that lingered (e.g. a
 *   missing 'done' row) so no stale placeholder is left behind.
 *
 * No-op if the session doesn't exist.
 */
export async function discardStaleProgressSession(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return;

  // Tool turns keep their collapsed Done summary.
  if (state.seenTool) {
    await finalizeProgressSession(sessionId);
    destroyProgressSession(sessionId);
    return;
  }

  // Thinking-only: delete the orphaned "Thinking…" bubble if one was shown.
  if (state.messageId && !state.sink.isCli && state.sink.deleteStatus) {
    try {
      await state.sink.deleteStatus(state.messageId);
    } catch (err) {
      if (!isBenignEditError(err)) {
        log.warn('ProgressController: failed to delete orphaned thinking bubble', { err });
      }
    }
  }
  destroyProgressSession(sessionId);
}

/** Remove session state without finalizing (e.g. on session teardown). */
export function destroyProgressSession(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  clearInterval(state.ticker);
  endSession(sessionId);
}

/** True if a progress session currently exists for this session. */
export function hasProgressSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** The current turn anchor (triggering inbound message id) for a session, or
 *  undefined if no progress session exists. Used to detect a new user turn. */
export function getProgressAnchor(sessionId: string): string | null | undefined {
  return sessions.get(sessionId)?.anchor;
}
