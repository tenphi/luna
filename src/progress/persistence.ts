/**
 * Durable record of the one live progress bubble per session, and the boot pass
 * that cleans up the ones a restart stranded.
 *
 * The ProgressController is entirely in-memory, which is right for a message
 * whose whole purpose is to tick — except that the platform doesn't forget.
 * When the host goes down mid-turn, Telegram keeps rendering whatever we last
 * wrote, so the user is left with "🤔 Thinking… 12s" from an hour ago, sitting
 * above no answer, permanently. There is nothing in memory left to correct it
 * and no other trace that the message exists.
 *
 * So the bubble's identity — not its contents, which are worthless after the
 * fact — is mirrored into `session_state`. On boot we read the leftovers back
 * and close them.
 *
 * Every write here is best-effort: a session DB that won't open must never take
 * down the live progress UI, and a bubble we fail to close is cosmetic.
 */
import fs from 'fs';

import { deleteSessionState, getSessionState, setSessionState } from '../db/session-db.js';
import { getActiveSessions, getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { openSession, sessionDbPath } from '../session-manager.js';
import { setProgressPersistence, type LiveBubbleRecord } from './controller.js';
import { buildProgressSink } from './status-events.js';

const KEY = 'progress:live';

/**
 * What the user sees on a bubble we abandoned. No elapsed time: the honest
 * number would include the entire downtime, which says nothing about the turn.
 */
const RESTART_NOTICE = '⚠️ Interrupted — Luna restarted before this finished.';

function withSessionDb<T>(sessionId: string, fn: (db: ReturnType<typeof openSession>) => T): T | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  if (!fs.existsSync(sessionDbPath(session.agent_group_id, sessionId))) return undefined;

  const db = openSession(session.agent_group_id, sessionId);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readRecord(db: ReturnType<typeof openSession>): LiveBubbleRecord | null {
  const raw = getSessionState(db, KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LiveBubbleRecord>;
    if (!parsed.messageId || !parsed.channelType || !parsed.platformId) return null;
    return {
      messageId: parsed.messageId,
      channelType: parsed.channelType,
      platformId: parsed.platformId,
      threadId: parsed.threadId ?? null,
      t0: typeof parsed.t0 === 'number' ? parsed.t0 : Date.now(),
      anchor: parsed.anchor ?? null,
    };
  } catch {
    return null;
  }
}

/** Wire the controller up to `session_state`. Called once on host start. */
export function installProgressPersistence(): void {
  setProgressPersistence({
    save(sessionId, record) {
      withSessionDb(sessionId, (db) => setSessionState(db, KEY, JSON.stringify(record)));
    },
    clear(sessionId) {
      withSessionDb(sessionId, (db) => deleteSessionState(db, KEY));
    },
  });
}

/**
 * Close bubbles left on screen by a host that went down mid-turn.
 *
 * Runs after the channel adapters are up, since closing one means editing a
 * real platform message. Any session whose record survived our own teardown by
 * definition never reached a terminal state.
 */
export async function reconcileOrphanedProgressBubbles(): Promise<number> {
  let closed = 0;

  for (const session of getActiveSessions()) {
    let record: LiveBubbleRecord | null | undefined;
    try {
      record = withSessionDb(session.id, (db) => {
        const rec = readRecord(db);
        // Drop it up front: a bubble we can't edit is not worth retrying on
        // every boot, and leaving the key would strand it forever.
        if (rec) deleteSessionState(db, KEY);
        return rec;
      });
    } catch (err) {
      log.warn('Failed to read stranded progress bubble', { sessionId: session.id, err });
      continue;
    }
    if (!record) continue;

    const sink = buildProgressSink(record.channelType, record.platformId, record.threadId);
    if (!sink || sink.isCli) continue;

    try {
      await sink.editStatus(record.messageId, RESTART_NOTICE);
      closed++;
    } catch (err) {
      log.warn('Failed to close stranded progress bubble', { sessionId: session.id, err });
    }
  }

  if (closed > 0) {
    log.info('Closed progress bubbles stranded by a restart', { count: closed });
  }
  return closed;
}
