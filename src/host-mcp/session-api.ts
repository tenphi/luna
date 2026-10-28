/**
 * Session API — the HTTP surface the container uses instead of opening the
 * per-session SQLite file across the mount.
 *
 * One RPC endpoint (`POST /session/:agentGroupId/:sessionId/rpc`) with a
 * `{ method, params }` body, authenticated with a per-session bearer token
 * (same `readOrCreatePairToken` mechanism as the MCP relays). Handlers map 1:1
 * to the container's SessionClient methods and are backed by the host session
 * store (src/db/session-db.ts). `writeMessageOut` delivers eagerly in-request.
 *
 * `writeStatus` is the exception: progress hints are ephemeral, so they are
 * applied straight to the live progress UI and never persisted.
 */
import {
  findCliResponse,
  findQuestionResponse,
  getDestinationRows,
  getMessageIdBySeq,
  getPendingForContainer,
  getRoutingBySeq,
  getSessionRoutingRow,
  getSessionState,
  insertOutboundMessage,
  listTasks,
  markCompleted,
  markProcessing,
  resolveDestinationThread,
  setSessionState,
  deleteSessionState,
  type WriteOutbound,
} from '../db/session-db.js';
import { getUsageSummary, recordUsage } from '../db/usage.js';
import { TIMEZONE } from '../config.js';
import type Database from 'better-sqlite3';

import { log } from '../log.js';
import { notePendingDigestReply, notePendingScheduledReply } from '../memory/digest.js';
import { prepareScheduledReport, type ScheduledEvidence } from '../memory/scheduled-evidence.js';
import { readMemoryEdits, acknowledgeMemoryEdits } from '../memory/page-watch.js';
import { stageMemoryFile } from '../memory/files.js';
import { applyStatusEvent } from '../progress/status-events.js';
import { recordPing } from '../session-liveness.js';
import { openSession } from '../session-manager.js';
import { readOrCreatePairToken } from './tokens.js';

const MAX_PENDING_LIMIT = 100;

/**
 * Hands a chat reply to the digest queue, if it is one.
 *
 * Only `chat`: a `system` message is an action payload and an `agent` one is addressed to
 * another agent, and neither is something the user read. Never throws — a digest that cannot
 * record the reply must not fail the write that carries the reply to the user.
 */
function noteReplyForDigest(db: Database.Database, msg: WriteOutbound): void {
  if (msg.kind !== 'chat') return;
  try {
    const content = JSON.parse(msg.content) as { text?: unknown; memory_evidence?: ScheduledEvidence };
    if (typeof content.text === 'string') {
      const run = msg.in_reply_to
        ? (db
            .prepare("SELECT id, series_id, process_after, timestamp FROM messages_in WHERE id = ? AND kind = 'task'")
            .get(msg.in_reply_to) as
            | { id: string; series_id: string | null; process_after: string | null; timestamp: string }
            | undefined)
        : undefined;
      const stored = db.prepare('SELECT timestamp FROM messages_out WHERE id = ?').get(msg.id) as
        | { timestamp: string }
        | undefined;
      const at = stored ? Date.parse(`${stored.timestamp.replace(' ', 'T')}Z`) : Date.now();
      const reply = { itemId: msg.id, text: content.text, at };
      if (run) {
        notePendingScheduledReply(
          db,
          { runId: run.id, seriesId: run.series_id ?? run.id, scheduledFor: run.process_after ?? run.timestamp },
          { ...reply, ...(content.memory_evidence ? { evidence: content.memory_evidence } : {}) },
        );
      } else {
        notePendingDigestReply(db, reply);
      }
    }
  } catch (err) {
    log.debug('could not record the reply for the memory digest', { err });
  }
}

/** Server name used to key the per-session bearer token. */
export function sessionTokenServerName(sessionId: string): string {
  return `session-${sessionId}`;
}

interface RpcRequest {
  headers: Record<string, string | string[] | undefined>;
  params: { agentGroupId: string; sessionId: string };
  body?: unknown;
}

interface RpcResponse {
  status: (n: number) => { json: (o: unknown) => void };
}

type Deliver = (agentGroupId: string, sessionId: string) => void;

/**
 * Register the Session API routes on the shared Express app. `deliver` is the
 * eager-delivery hook (fires a session drain in-request after an outbound
 * write); injected to avoid an import cycle with delivery.ts.
 */
export function registerSessionApi(
  app: { post: (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => void },
  deliver: Deliver,
): void {
  const handler = async (reqU: unknown, resU: unknown): Promise<void> => {
    const req = reqU as RpcRequest;
    const res = resU as RpcResponse;
    const { agentGroupId, sessionId } = req.params;

    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const expected = readOrCreatePairToken(agentGroupId, sessionTokenServerName(sessionId));
    if (authHeader !== `Bearer ${expected}`) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as { method?: string; params?: Record<string, unknown> };
    const method = body.method;
    const params = body.params ?? {};
    if (!method) {
      res.status(400).json({ ok: false, error: 'Missing method' });
      return;
    }

    try {
      const result = await dispatch(agentGroupId, sessionId, method, params, deliver);
      res.status(200).json({ ok: true, result });
    } catch (err) {
      log.error('Session API error', { agentGroupId, sessionId, method, err });
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  app.post('/session/:agentGroupId/:sessionId/rpc', handler);
}

async function dispatch(
  agentGroupId: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  deliver: Deliver,
): Promise<unknown> {
  // ping needs no DB.
  if (method === 'ping') {
    recordPing(sessionId, {
      setTool: params.setTool === true,
      tool: (params.tool as string | null | undefined) ?? null,
      toolDeclaredTimeoutMs: (params.toolDeclaredTimeoutMs as number | null | undefined) ?? null,
      toolStartedAt: (params.toolStartedAt as string | null | undefined) ?? null,
    });
    return null;
  }

  // Usage lives in the central DB, not this session's file. The identity comes
  // from the authenticated route path, so a container can only bill itself.
  if (method === 'recordUsage') {
    recordUsage(
      {
        agentGroupId,
        sessionId,
        episodeId: (params.episodeId as string | null | undefined) ?? '',
        provider: (params.provider as string | undefined) ?? 'openai',
        model: (params.model as string | null | undefined) ?? '',
        promptTokens: Number(params.promptTokens) || 0,
        completionTokens: Number(params.completionTokens) || 0,
        cachedTokens: Number(params.cachedTokens) || 0,
        cachedTokensKnown: params.cachedTokensKnown !== false,
      },
      TIMEZONE,
    );
    return null;
  }
  if (method === 'getUsageSummary') {
    return getUsageSummary({ sessionId, episodeId: (params.episodeId as string | null | undefined) ?? null }, TIMEZONE);
  }

  if (method === 'stageMemoryFile') {
    return stageMemoryFile(
      agentGroupId,
      sessionId,
      params.document as string,
      params.id as string,
      params.filename as string | undefined,
    );
  }

  const db = openSession(agentGroupId, sessionId);
  try {
    switch (method) {
      case 'readMemoryEdits':
        return await readMemoryEdits(db, { agentGroupId, sessionId });
      case 'acknowledgeMemoryEdits':
        acknowledgeMemoryEdits(
          db,
          Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string') : [],
        );
        return null;
      case 'getPendingMessages': {
        const isFirstPoll = params.isFirstPoll === true;
        const limit = Math.min(Math.max(1, Number(params.limit) || 10), MAX_PENDING_LIMIT);
        return getPendingForContainer(db, isFirstPoll, limit);
      }
      case 'markProcessing':
        markProcessing(db, (params.ids as string[]) ?? []);
        return null;
      case 'markCompleted':
        markCompleted(db, (params.ids as string[]) ?? []);
        return null;
      case 'findQuestionResponse':
        return findQuestionResponse(db, params.questionId as string) ?? null;
      case 'writeMessageOut': {
        const msg = prepareScheduledReport(db, params.msg as WriteOutbound);
        const seq = insertOutboundMessage(db, msg);
        // The turn's answer, for the after-the-turn digest. This is the only place the reply
        // exists on the host before the sweep runs — the router queues the user's words at
        // routing time, when there is no answer yet, which is why research findings reached
        // the extractor as nothing at all.
        //
        // Here rather than at delivery: everything through this method came from inside the
        // container, while the digest's own owner-facing note is an outbound chat message too,
        // and capturing at delivery would feed each digest its predecessor's summary.
        noteReplyForDigest(db, msg);
        db.close();
        // Deliver eagerly so responses land without waiting on a poll.
        deliver(agentGroupId, sessionId);
        return { seq };
      }
      // Ephemeral progress hint — applied to the live UI, never persisted.
      case 'writeStatus': {
        await applyStatusEvent(sessionId, db, {
          channelType: (params.channelType as string | null | undefined) ?? null,
          platformId: (params.platformId as string | null | undefined) ?? null,
          threadId: (params.threadId as string | null | undefined) ?? null,
          inReplyTo: (params.inReplyTo as string | null | undefined) ?? null,
          payload: (params.payload as Record<string, unknown> | undefined) ?? {},
        });
        return null;
      }
      case 'getMessageIdBySeq':
        return getMessageIdBySeq(db, Number(params.seq));
      case 'getRoutingBySeq':
        return getRoutingBySeq(db, Number(params.seq));
      case 'getDestinations':
        return getDestinationRows(db);
      case 'getSessionRouting':
        return getSessionRoutingRow(db);
      case 'resolveDestinationThread':
        return resolveDestinationThread(db, params.channelType as string, params.platformId as string);
      case 'listTasks':
        return listTasks(db, (params.status as string | null | undefined) ?? null);
      case 'getSessionState':
        return { value: getSessionState(db, params.key as string) };
      case 'setSessionState':
        setSessionState(db, params.key as string, params.value as string);
        return null;
      case 'deleteSessionState':
        deleteSessionState(db, params.key as string);
        return null;
      case 'findCliResponse':
        return findCliResponse(db, params.requestId as string);
      default:
        throw new Error(`Unknown session method: ${method}`);
    }
  } finally {
    try {
      db.close();
    } catch {
      // writeMessageOut already closed it before delivering.
    }
  }
}
