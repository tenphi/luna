/**
 * Container status events → live progress UI.
 *
 * Status events are ephemeral UI hints: they must never be retried, and they
 * are worthless the moment they are stale. They therefore bypass `messages_out`
 * entirely and arrive as a direct Session API call (`writeStatus`), which calls
 * `applyStatusEvent` here.
 *
 * They used to be `kind:'status'` outbound rows, which wrapped durable,
 * sequenced, delivery-tracked, retryable infrastructure around data with none
 * of those requirements — and cost a `seq`, a `messages_out` row and a
 * `delivered` row per progress tick. On a long-lived session that was ~94% of
 * the outbound table (7121 status rows vs 448 chat rows in one measured
 * install), which also made the delivery drain's full-table scans grow without
 * bound. Nothing is persisted now.
 */
import type Database from 'better-sqlite3';

import { getInboundTimestampMs } from '../db/session-db.js';
import { stopTypingRefresh } from '../modules/typing/index.js';
import { endReplyStream, noteReplyText } from './reply-stream.js';
import {
  createProgressSession,
  discardStaleProgressSession,
  getProgressAnchor,
  handleStatusEvent,
  hasProgressSession,
  type ProgressSink,
} from './controller.js';

/**
 * Factory that builds a ProgressSink for a given channel destination.
 * Set by index.ts once the channel registry is ready.
 */
type ProgressSinkFactory = (channelType: string, platformId: string, threadId: string | null) => ProgressSink | null;
let progressSinkFactory: ProgressSinkFactory | null = null;

export function setProgressSinkFactory(factory: ProgressSinkFactory): void {
  progressSinkFactory = factory;
}

/** Build a sink for an arbitrary destination. Used by boot reconciliation. */
export function buildProgressSink(
  channelType: string,
  platformId: string,
  threadId: string | null,
): ProgressSink | null {
  return progressSinkFactory?.(channelType, platformId, threadId) ?? null;
}

export interface ContainerStatusEvent {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  /** Triggering inbound message id — the turn anchor and T0 source. */
  inReplyTo: string | null;
  payload: Record<string, unknown>;
}

/**
 * Apply one status event to the session's progress UI, creating the progress
 * session lazily on the first event of a turn.
 *
 * `db` is the caller's already-open session DB, used only to resolve T0 from
 * the triggering inbound message.
 */
export async function applyStatusEvent(
  sessionId: string,
  db: Database.Database,
  ev: ContainerStatusEvent,
): Promise<void> {
  if (!progressSinkFactory || !ev.channelType || !ev.platformId) return;

  const content = ev.payload;
  const phase = typeof content.phase === 'string' ? content.phase : '';
  const anchor = ev.inReplyTo ?? null;

  // New user turn (the triggering inbound message changed) → close the previous
  // turn's bubble as its own message and start a fresh one. Guarantees a new
  // turn never edits the previous message (the "jump" bug), and keeps T0/reveal
  // correct even for a follow-up pushed into a still-open query.
  if (hasProgressSession(sessionId) && getProgressAnchor(sessionId) !== anchor) {
    // Tool turns collapse to their "Done" summary; a thinking-only bubble that
    // was never merged into an answer is deleted rather than left on "Thinking…".
    await discardStaleProgressSession(sessionId);
  }

  if (phase === 'done' && !hasProgressSession(sessionId)) {
    return;
  }

  // Ensure a progress session exists for this session.
  if (!hasProgressSession(sessionId)) {
    // Resolve T0 from the triggering inbound message's timestamp.
    const t0Ms = ev.inReplyTo ? getInboundTimestampMs(db, ev.inReplyTo) : null;
    const t0 = t0Ms ?? Date.now();

    const sink = progressSinkFactory(ev.channelType, ev.platformId, ev.threadId);
    if (!sink) return; // channel doesn't support progress (e.g. agent-to-agent)
    createProgressSession(sessionId, t0, sink, {
      channelType: ev.channelType,
      platformId: ev.platformId,
      threadId: ev.threadId,
      anchor,
    });
  }

  // Live reply preview. The bubble ignores prose by design; this shows it on
  // channels that can display growing text without notifying. Fire-and-forget
  // and heavily throttled — see reply-stream.ts — so the status write never
  // waits on a platform call.
  if (phase === 'generating' && typeof content.text === 'string' && content.text) {
    noteReplyText(
      sessionId,
      { channelType: ev.channelType, platformId: ev.platformId, threadId: ev.threadId },
      content.text,
    );
  }

  await handleStatusEvent(sessionId, {
    phase,
    effort: typeof content.effort === 'string' ? content.effort : undefined,
    name: typeof content.name === 'string' ? content.name : undefined,
    args:
      content.args && typeof content.args === 'object' && !Array.isArray(content.args)
        ? (content.args as Record<string, unknown>)
        : undefined,
    message: typeof content.message === 'string' ? content.message : undefined,
    text: typeof content.text === 'string' ? content.text : undefined,
    partial: content.partial === true ? true : content.partial === false ? false : undefined,
    index: typeof content.index === 'number' ? content.index : undefined,
  });

  // Turn finished — stop the platform typing indicator. Do this even when the
  // progress session is kept for a thinking-only answer edit; otherwise idle
  // heartbeats would keep "Typing…" on after the work is done.
  if (phase === 'done') {
    stopTypingRefresh(sessionId);
    endReplyStream(sessionId);
  }
}
