import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  getMessageForRetry,
  getProcessingClaims,
  getProcessingIds,
  getSessionRoutingRow,
  insertOutboundMessage,
  markMessageFailed,
  retryWithBackoff,
} from './db/session-db.js';
import { deliverSessionMessages, deliverSessionNow } from './delivery.js';
import { describeDigest, recoverScheduledReports, runPendingDigest } from './memory/digest.js';
import { reconcileMemoryPages, stopMemoryPageWatches } from './memory/page-watch.js';
import { deliverMemoryChanges, hasPendingMemoryChanges } from './memory/change-notifications.js';
import { finalizeProgressSession, hasProgressSession, interruptProgressSession } from './progress/controller.js';
import { log } from './log.js';
import { getLiveness } from './session-liveness.js';
import { openSession, sessionDbPath } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If we haven't seen a liveness
// ping in this long, the container is either stuck or doing genuinely nothing
// — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

/** In-flight tool snapshot used by the stuck heuristics. */
export interface ToolState {
  tool: string | null;
  toolDeclaredTimeoutMs: number | null;
}

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; DB + liveness reads happen in the caller.
 *
 * `lastSeenMs` is 0 when the host has never received a ping for this session
 * this process lifetime (e.g. fresh spawn, or host just restarted) — treated
 * like a missing heartbeat: the ceiling check is skipped so we don't kill a
 * container before it's had a chance to check in.
 */
export function decideStuckAction(args: {
  now: number;
  lastSeenMs: number;
  tool: ToolState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, lastSeenMs, tool, claims } = args;
  const declaredBashMs = bashTimeoutMs(tool);

  if (lastSeenMs !== 0) {
    const heartbeatAge = now - lastSeenMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (lastSeenMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

let sweepEpoch = 0;
let activeEpoch: number | undefined;
let nextSweep: NodeJS.Timeout | undefined;
export function startHostSweep(): void {
  if (activeEpoch !== undefined) return;
  activeEpoch = ++sweepEpoch;
  void sweep(activeEpoch);
}
export function stopHostSweep(): void {
  activeEpoch = undefined;
  if (nextSweep) clearTimeout(nextSweep);
  nextSweep = undefined;
  stopMemoryPageWatches();
}
async function sweep(epoch: number): Promise<void> {
  if (activeEpoch !== epoch) return;
  try {
    for (const session of getActiveSessions()) {
      if (activeEpoch !== epoch) break;
      try {
        await sweepSession(session);
      } catch (error) {
        log.error('Maintenance failed for a session', { sessionId: session.id, error });
      }
    }
  } catch (error) {
    log.error('Could not enumerate maintenance work', { error });
  }
  if (activeEpoch === epoch) {
    nextSweep = setTimeout(() => void sweep(epoch), SWEEP_INTERVAL_MS);
    nextSweep.unref();
  }
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  if (!fs.existsSync(sessionDbPath(agentGroup.id, session.id))) return;

  let db: Database.Database;
  try {
    db = openSession(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    // 1. Wake a container if work is due and nothing is running.
    const dueCount = countDueMessages(db);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      if (await wakeContainer(session)) {
        consecutiveWakeFailures.delete(session.id);
      } else {
        noteWakeFailure(db, session);
      }
    }

    const alive = isContainerRunning(session.id);

    // 2. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive) {
      await enforceRunningContainerSla(db, session);
    }

    // 3. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 1 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive) {
      const recovery = resetStuckProcessingRows(db, session, 'container not running');

      if (recovery.retried + recovery.failed > 0) {
        // The turn died mid-flight. Say so on the bubble instead of collapsing
        // it to a Done summary for an answer that never arrived.
        await reportInterruptedTurn(session, recovery);
      } else if (hasProgressSession(session.id) && getProcessingClaims(db).length === 0) {
        // Nothing was in flight — the container simply exited after finishing.
        // Finalize any lingering live process message (idempotent) so a missing
        // 'done' row can't wedge stale state into the next turn.
        await finalizeProgressSession(session.id);
      }
    }

    // 4. Recurrence fanout for completed recurring tasks.
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(db, session);

    // 5. Learn from what was said, once the turn is genuinely over.
    //
    // "Over" means nothing due and nothing claimed: a container idles between turns, so its being
    // alive proves nothing. Waiting also lets a burst of messages travel as one ordered source,
    // which is better input — "the rent is going up" and "from September" are one fact in two messages.
    if (countDueMessages(db) === 0 && getProcessingIds(db).length === 0) {
      try {
        recoverScheduledReports(db);
        const digested = await runPendingDigest(db, { agentGroupId: agentGroup.id, sessionId: session.id });
        const note = digested
          ? describeDigest({ ...digested, receiptNotifications: hasPendingMemoryChanges(db) })
          : null;
        if (note) {
          // Stamped with the session's own routing, because delivery *throws* on a row with no
          // channel_type/platform_id — a note queued without them is a note nobody ever sees, plus
          // a delivery error every sweep until the row gives up. A session that has not been
          // routed yet (no snapshot) has nowhere to send: skip rather than queue an undeliverable.
          const routing = getSessionRoutingRow(db);
          if (routing.channel_type && routing.platform_id) {
            insertOutboundMessage(db, {
              id: `msg-${Date.now()}-digest`,
              kind: 'chat',
              channel_type: routing.channel_type,
              platform_id: routing.platform_id,
              thread_id: routing.thread_id,
              // Every chat row is a JSON delivery envelope. Passing the note
              // as raw text made delivery's JSON.parse throw three times, so
              // memory changed successfully but its owner-facing summary was
              // permanently marked failed.
              content: JSON.stringify({ text: note }),
            });
          } else {
            log.warn('memory digest wrote pages but the session has no routing snapshot — note not sent', {
              sessionId: session.id,
            });
          }
        }

        // 5b. Finish foreground memory proposals.
        //
        // `retain` holds are part of its content-free receipt and were reported above. This pass is
        // still needed for proposals raised by the agent's foreground `remember` or `ingest` calls:
        // routing misses go back to the agent, while factual conflicts remain owner decisions.
        // Proposals raised by earlier turns can still be waiting. One memory read per digested turn.
        if (digested) {
          const { handlePendingProposals } = await import('./modules/memory-approval/index.js');
          await handlePendingProposals(session);
        }
        await deliverMemoryChanges(db);
      } catch (err) {
        log.error('memory digest failed', { sessionId: session.id, err });
      }
    }

    await reconcileMemoryPages(db, { agentGroupId: agentGroup.id, sessionId: session.id });

    // 6. Drain the outbound queue last, so anything the steps above queued
    // (failure notices, recurrence fanout, the memory note) goes out on this same tick.
    // Delivery is otherwise eager via the Session API; this is the backstop
    // for scheduled rows and host-written rows whose eager attempt failed.
    // Reuses our open handle rather than reopening the file.
    await deliverSessionMessages(session, db);
  } finally {
    db.close();
  }
}

function toolStateFor(sessionId: string): ToolState | null {
  const live = getLiveness(sessionId);
  if (!live) return null;
  return { tool: live.tool, toolDeclaredTimeoutMs: live.toolDeclaredTimeoutMs };
}

function lastSeenMsFor(sessionId: string): number {
  return getLiveness(sessionId)?.lastSeenMs ?? 0;
}

function bashTimeoutMs(state: ToolState | null): number | null {
  if (!state || state.tool !== 'Bash') return null;
  return typeof state.toolDeclaredTimeoutMs === 'number' ? state.toolDeclaredTimeoutMs : null;
}

async function enforceRunningContainerSla(db: Database.Database, session: Session): Promise<void> {
  const decision = decideStuckAction({
    now: Date.now(),
    lastSeenMs: lastSeenMsFor(session.id),
    tool: toolStateFor(session.id),
    claims: getProcessingClaims(db),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    await reportInterruptedTurn(session, resetStuckProcessingRows(db, session, 'absolute-ceiling'));
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  await reportInterruptedTurn(session, resetStuckProcessingRows(db, session, 'claim-stuck'));
}

/**
 * Correct the live progress bubble after the sweep cut a turn short.
 *
 * Retrying used to be entirely silent: the bubble kept ticking (or froze on a
 * stale "🤔 Thinking… 47s") through the whole backoff, and the user had no way
 * to tell a retry in progress from an assistant that had given up. Naming the
 * wait is the difference between "it's working on it" and "it's broken".
 */
async function reportInterruptedTurn(session: Session, recovery: RecoveryOutcome): Promise<void> {
  if (!hasProgressSession(session.id)) return;
  const note = recovery.nextRetrySec !== null ? `retrying in ${recovery.nextRetrySec}s` : undefined;
  await interruptProgressSession(session.id, note);
}

export function _resetStuckProcessingRowsForTesting(
  db: Database.Database,
  session: Session,
  reason: string,
): RecoveryOutcome {
  return resetStuckProcessingRows(db, session, reason);
}

/**
 * Consecutive failed wakes per session.
 *
 * In memory on purpose: a host restart is itself a plausible fix for whatever
 * is blocking the spawn, so starting the count over is the right behaviour.
 */
const consecutiveWakeFailures = new Map<string, number>();

/**
 * Sweeps' worth of failed wakes to absorb silently before telling the user.
 * At one sweep a minute that is roughly five minutes of trying.
 */
export const MAX_SILENT_WAKE_FAILURES = 5;

/**
 * A wake failed, so the messages that triggered it are still pending with
 * nothing running to pick them up.
 *
 * The sweep retries forever, which is right — a spawn failure is usually the
 * OneCLI gateway or the container runtime coming back. What was wrong is that it
 * did so in total silence: from the chat's point of view the message was simply
 * ignored, indefinitely. Tell the user once per outage and keep retrying, so a
 * recovery still answers them.
 */
function noteWakeFailure(db: Database.Database, session: Session): void {
  const failures = (consecutiveWakeFailures.get(session.id) ?? 0) + 1;
  consecutiveWakeFailures.set(session.id, failures);

  if (failures !== MAX_SILENT_WAKE_FAILURES) return;

  log.error('Container wake failing repeatedly — notifying user', {
    sessionId: session.id,
    failures,
  });
  notifyUser(
    db,
    session,
    'wake-failing',
    "I can't start up right now, so I haven't been able to read your message. I'll keep trying and reply once I'm back.",
  );
}

export function _noteWakeFailureForTesting(db: Database.Database, session: Session): void {
  noteWakeFailure(db, session);
}

export function _resetWakeFailuresForTesting(): void {
  consecutiveWakeFailures.clear();
}

/**
 * Say something in the chat instead of leaving it silently hanging.
 *
 * Best-effort: reads the session's default reply destination from
 * `session_routing` and writes a `chat` row into the outbound queue so the
 * normal delivery loop sends it. Skips A2A / unrouted sessions (no channel
 * destination) and swallows all errors — a failed apology must not itself
 * become a failure.
 */
function notifyUser(db: Database.Database, session: Session, reason: string, text: string): void {
  try {
    const routing = db
      .prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
      .get() as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;

    if (!routing?.channel_type || !routing.platform_id) return;

    // Write through the caller's open handle. Going via the path-based
    // writeOutboundMessage would reopen the same file we are already holding.
    insertOutboundMessage(db, {
      id: `fail-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
    deliverSessionNow(session.agent_group_id, session.id);
    log.info('Sent failure notice to user', { sessionId: session.id, reason });
  } catch (err) {
    log.warn('Failed to send failure notice to user', { sessionId: session.id, err });
  }
}

/** What one recovery pass did to the messages a dead turn left behind. */
export interface RecoveryOutcome {
  /** Rows put back on the queue with backoff. */
  retried: number;
  /** Rows that ran out of tries and were given up on. */
  failed: number;
  /** Shortest scheduled retry, in seconds — null when nothing will be retried. */
  nextRetrySec: number | null;
}

function resetStuckProcessingRows(db: Database.Database, session: Session, reason: string): RecoveryOutcome {
  const claims = getProcessingClaims(db);
  const now = Date.now();
  const outcome: RecoveryOutcome = { retried: 0, failed: 0, nextRetrySec: null };

  for (const { message_id } of claims) {
    const msg = getMessageForRetry(db, message_id);
    if (!msg || msg.status !== 'processing') continue;

    // Already rescheduled for a future retry — don't bump tries again.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(db, msg.id);
      outcome.failed++;
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
      notifyUser(
        db,
        session,
        reason,
        "Sorry — I couldn't finish that request (it timed out or hit an error). Please try again.",
      );
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(db, msg.id, backoffSec);
      outcome.retried++;
      outcome.nextRetrySec = outcome.nextRetrySec === null ? backoffSec : Math.min(outcome.nextRetrySec, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  return outcome;
}
