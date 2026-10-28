import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { createPendingQuestion, getSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getUndeliveredOutboundMessages,
  markDelivered,
  markDeliveryFailed,
  recordDeliveryAttempt,
  getProcessingIds,
} from './db/session-db.js';
import { log } from './log.js';
import { adapterRateLimitRetryAfterSec } from './channels/adapter-errors.js';
import { normalizeOptions } from './channels/ask-question.js';
import { notifyCliTurnComplete } from './channels/cli.js';
import { clearOutbox, openSession, readOutboxFiles, sessionDbPath } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter, stopTypingRefresh } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import { displayFileNames } from './delivery-file-names.js';
import type { Session } from './types.js';
import { hasProgressSession } from './progress/controller.js';

type Handle = Database.Database;
type Outgoing = ReturnType<typeof getUndeliveredOutboundMessages>[number];
export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    messageId?: string,
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}
export type DeliveryActionHandler = (content: Record<string, unknown>, session: Session, inDb: Handle) => Promise<void>;
type Ready = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const actions: Record<string, DeliveryActionHandler> = Object.create(null);
const ready: Ready[] = [];
let transport: ChannelDeliveryAdapter | null = null;
const draining = new Set<string>();
const requested = new Set<string>();
const backoff = new Map<string, number>();
const timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
const batchSize = 200;

export const getDeliveryAdapter = (): ChannelDeliveryAdapter | null => transport;
function inform(callback: Ready, adapter: ChannelDeliveryAdapter): void {
  void Promise.resolve()
    .then(() => callback(adapter))
    .catch((err) => log.error('Delivery startup hook failed', { err }));
}
export function onDeliveryAdapterReady(callback: Ready): void {
  ready.push(callback);
  if (transport) inform(callback, transport);
}
export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  transport = adapter;
  setTypingAdapter(adapter);
  ready.forEach((callback) => inform(callback, adapter));
}
export function registerDeliveryAction(name: string, handler: DeliveryActionHandler): void {
  if (actions[name]) log.warn('Replacing delivery action', { action: name });
  actions[name] = handler;
}
export function deliverSessionNow(agentId: string, sessionId: string): void {
  const session = getSession(sessionId);
  if (session?.agent_group_id === agentId) void deliverSessionMessages(session);
}

function openExisting(session: Session): Handle | undefined {
  if (!getAgentGroup(session.agent_group_id) || !fs.existsSync(sessionDbPath(session.agent_group_id, session.id)))
    return;
  return openSession(session.agent_group_id, session.id);
}
export async function deliverSessionMessages(session: Session, existing?: Handle): Promise<void> {
  if (draining.has(session.id)) {
    requested.add(session.id);
    return;
  }
  draining.add(session.id);
  let handle: Handle | undefined;
  try {
    handle = existing ?? openExisting(session);
    if (!handle) return;
    do {
      requested.delete(session.id);
      await drain(session, handle);
    } while (requested.has(session.id));
  } catch (err) {
    log.error('Session delivery failed', { sessionId: session.id, err });
  } finally {
    if (handle && !existing) handle.close();
    draining.delete(session.id);
  }
  if (requested.delete(session.id)) await deliverSessionMessages(session, existing);
}

function retryLater(session: Session, seconds: number): void {
  const at = Date.now() + seconds * 1000 + 250;
  const scheduled = timers.get(session.id);
  if (scheduled && scheduled.at >= at) return;
  if (scheduled) clearTimeout(scheduled.timer);
  const timer = setTimeout(
    () => {
      timers.delete(session.id);
      deliverSessionNow(session.agent_group_id, session.id);
    },
    Math.max(0, at - Date.now()),
  );
  timer.unref();
  timers.set(session.id, { at, timer });
}

async function drain(session: Session, handle: Handle): Promise<void> {
  const rows = getUndeliveredOutboundMessages(handle, batchSize);
  let retired = 0;
  let retrySeconds = 0;
  let cliDelivered = false;
  for (const row of rows) {
    if ((backoff.get(row.id) ?? 0) > Date.now()) continue;
    try {
      const deliveredId = await send(row, session, handle);
      markDelivered(handle, row.id, deliveredId ?? null);
      retired++;
      backoff.delete(row.id);
      if (row.kind !== 'system' && row.channel_type !== 'agent') {
        if (hasProgressSession(session.id)) pauseTypingRefreshAfterDelivery(session.id);
        else stopTypingRefresh(session.id);
      }
      cliDelivered ||= row.channel_type === 'cli' && row.platform_id === 'local' && row.kind !== 'cli-tool';
    } catch (err) {
      const seconds = adapterRateLimitRetryAfterSec(err);
      if (seconds !== null) {
        backoff.set(row.id, Date.now() + seconds * 1000);
        retrySeconds = Math.max(retrySeconds, seconds);
        log.warn('Delivery deferred by channel rate limit', { sessionId: session.id, messageId: row.id, seconds });
      } else {
        const attempts = recordDeliveryAttempt(handle, row.id);
        if (attempts >= 3) {
          markDeliveryFailed(handle, row.id);
          backoff.delete(row.id);
          retired++;
          log.error('Delivery attempt budget exhausted', { sessionId: session.id, messageId: row.id, attempts, err });
        } else log.warn('Delivery will be retried', { sessionId: session.id, messageId: row.id, attempts, err });
      }
    }
  }
  // Backed-off rows can fill a batch. Re-reading without progress would spin forever.
  if (rows.length === batchSize && retired > 0) requested.add(session.id);
  if (retrySeconds) retryLater(session, retrySeconds);
  if (cliDelivered && !getProcessingIds(handle).length) notifyCliTurnComplete();
}

function authorizeChannel(row: Outgoing, session: Session): void {
  const target = getMessagingGroupByPlatform(row.channel_type!, row.platform_id!);
  if (!target)
    throw new Error(`unknown messaging group for ${row.channel_type}/${row.platform_id} (message ${row.id})`);
  if (target.id === session.messaging_group_id) return;
  const allowed = getDb()
    .prepare(
      `SELECT id FROM agent_destinations
    WHERE target_id = ? AND target_type = 'channel' AND agent_group_id = ? LIMIT 1`,
    )
    .get(target.id, session.agent_group_id);
  if (!allowed)
    throw new Error(
      `unauthorized channel destination: ${session.agent_group_id} cannot send to ${row.channel_type}/${row.platform_id}`,
    );
}
function rememberQuestion(content: Record<string, unknown>, row: Outgoing, session: Session): void {
  if (content.type !== 'ask_question' || !content.questionId) return;
  if (typeof content.title !== 'string' || !Array.isArray(content.options)) {
    log.error('Question has no title or options', { messageId: row.id });
    return;
  }
  createPendingQuestion({
    question_id: String(content.questionId),
    title: content.title,
    options: normalizeOptions(content.options as never),
    session_id: session.id,
    message_out_id: row.id,
    platform_id: row.platform_id,
    channel_type: row.channel_type,
    thread_id: row.thread_id,
    created_at: new Date().toISOString(),
  });
}
function caption(content: Record<string, unknown>, row: Outgoing, handle: Handle): string {
  if (typeof content.text !== 'string' || !content.text.includes('/workspace/')) return JSON.stringify(content);
  const inbound = row.in_reply_to
    ? (handle.prepare('SELECT content FROM messages_in WHERE id = ?').get(row.in_reply_to) as
        | { content: string }
        | undefined)
    : undefined;
  let request = inbound?.content ?? '';
  try {
    request = (JSON.parse(request) as { text?: string }).text ?? '';
  } catch {
    /* Raw text is valid input. */
  }
  return JSON.stringify({ ...content, text: displayFileNames(content.text, request) });
}
async function send(row: Outgoing, session: Session, handle: Handle): Promise<string | undefined> {
  const adapter = transport;
  if (!adapter) throw new Error(`no delivery adapter configured (message ${row.id})`);
  const parsed: unknown = JSON.parse(row.content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Outbound content must be an object');
  const {
    memory_evidence: _memory,
    source_email_ids: _emailIds,
    source_email_findings: _findings,
    ...content
  } = parsed as Record<string, unknown>;
  if (row.kind === 'system') {
    const name = String(content.action ?? '');
    if (actions[name]) await actions[name](content, session, handle);
    else log.warn('Unknown system action', { action: name });
    return;
  }
  if (row.channel_type === 'agent') {
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage({ ...row, content: JSON.stringify(content) }, session);
    return;
  }
  if (!row.channel_type || !row.platform_id)
    throw new Error(`message missing routing fields: channel_type/platform_id (message ${row.id})`);
  authorizeChannel(row, session);
  rememberQuestion(content, row, session);
  const files =
    Array.isArray(content.files) && content.files.length
      ? readOutboxFiles(session.agent_group_id, session.id, row.id, content.files as string[])
      : undefined;
  const id = await adapter.deliver(
    row.channel_type,
    row.platform_id,
    row.thread_id,
    row.kind,
    caption(content, row, handle),
    files,
    row.id,
  );
  clearOutbox(session.agent_group_id, session.id, row.id);
  log.info('Outbound accepted', { id: row.id, platformMsgId: id, fileCount: files?.length });
  return id;
}
