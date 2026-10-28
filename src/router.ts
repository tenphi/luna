import { randomUUID } from 'node:crypto';
import { ensureCliWiring } from './bootstrap.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { gateCommand } from './command-gate.js';
import { renderCommandHelp } from './commands.js';
import { getAgentGroup } from './db/agent-groups.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupWithAgentCount,
} from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { startTypingRefresh, stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { MEMORY_COMMANDS } from './memory/commands.js';
import { restartSessionContainer } from './container-restart.js';
import { hotMemorySlugFor, isOwner, resolveUserKey } from './users/binding.js';
import { rosterUser } from './users/roster.js';
import { transcribeInboundContent } from './voice/inbound.js';
import {
  resolveSession,
  createEphemeralSession,
  writeSessionMessage,
  writeOutboundMessage,
  openSession,
} from './session-manager.js';
import { deliverSessionNow } from './delivery.js';
import { wakeContainer, killContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import { completeAllProcessing, lookupQuotedMessageByPlatformId } from './db/session-db.js';
import { evaluateEligibility, forwardedFrom, notePendingDigest, repliedTo } from './memory/digest.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';
import type { InboundEvent } from './channels/adapter.js';

/** The text after a slash command, e.g. `/report it saved the wrong page` → the complaint. */
function commandArgument(rawContent: string, command: string): string {
  let text = rawContent.trim();
  try {
    const parsed = JSON.parse(text) as { text?: unknown };
    if (typeof parsed.text === 'string') text = parsed.text.trim();
  } catch {
    // Not JSON — the raw string is the message.
  }
  if (!text.toLowerCase().startsWith(command)) return '';
  return text.slice(command.length).trim();
}

/**
 * The last few messages of the session, as plain text, stored with a report.
 *
 * Captured now because sessions are garbage-collected: a complaint that outlives its transcript is
 * one nobody can act on. Bounded hard — this is an illustration, not an archive.
 */
function recentExchange(agentGroupId: string, sessionId: string, limit = 6): string | null {
  try {
    const db = openSession(agentGroupId, sessionId);
    try {
      const rows = db
        .prepare(
          `SELECT 'in' AS side, content, seq FROM messages_in
           UNION ALL
           SELECT 'out' AS side, content, seq FROM messages_out
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(limit) as { side: string; content: string }[];
      const lines = rows.reverse().map((row) => {
        let text = row.content;
        try {
          const parsed = JSON.parse(row.content) as { text?: unknown };
          if (typeof parsed.text === 'string') text = parsed.text;
        } catch {
          // Keep the raw content when it is not an envelope.
        }
        return `${row.side === 'in' ? 'user' : 'luna'}: ${text.slice(0, 400)}`;
      });
      return lines.length > 0 ? lines.join('\n') : null;
    } finally {
      db.close();
    }
  } catch {
    // A report is worth keeping even when its context cannot be read.
    return null;
  }
}

function generateId(): string {
  return `msg-${randomUUID()}`;
}

/**
 * Write a host-originated reply (command denials, restart acks) to the
 * session's outbound queue and deliver it immediately. Used by the command
 * gate, which acts without waking a container.
 */
function sendHostReply(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  writeOutboundMessage(agentGroupId, sessionId, message);
  deliverSessionNow(agentGroupId, sessionId);
}

/**
 * Stamp `_luna.senderIsPrivileged`, `_luna.userId`, and `_luna.episodesEnabled`
 * on inbound JSON so the container can tailor operator-facing error detail,
 * attribute chat, and segment topics without querying luna.db.
 */
export function stampInboundPrivilege(
  content: string,
  userId: string | null,
  opts?: { episodesEnabled?: boolean },
): string {
  const senderIsPrivileged = userId !== null && isOwner(userId);
  const lunaPatch: Record<string, unknown> = { senderIsPrivileged };
  if (userId) lunaPatch.userId = userId;
  // The speaker's hot-memory page. Resolved here rather than in the container because it is named for
  // the person's key in `config/local.jsonc`, and the container has no view of the roster.
  const hotMemorySlug = userId ? hotMemorySlugFor(userId) : null;
  if (hotMemorySlug) lunaPatch.hotMemorySlug = hotMemorySlug;
  if (opts?.episodesEnabled !== undefined) lunaPatch.episodesEnabled = opts.episodesEnabled;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const existing = (parsed._luna as Record<string, unknown> | undefined) ?? {};
    return JSON.stringify({ ...parsed, _luna: { ...existing, ...lunaPatch } });
  } catch {
    // Non-JSON payloads — wrap so the container can still read privilege without changing the
    // visible text.
    return JSON.stringify({ text: content, _luna: lunaPatch });
  }
}

/**
 * When the platform embeds a reply-to with empty text (common for Telegram
 * Rich Markdown agent messages), fill `replyTo.text` from a lookup by
 * platform message id so the agent still sees the quoted original after
 * `/clear` or history compaction.
 *
 * `lookup` is injected so unit tests can exercise the JSON rewrite without
 * opening a session DB.
 */
export function hydrateReplyContextContent(
  content: string,
  lookup: (platformMessageId: string) => { text: string; sender?: string } | null,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }

  const replyTo = parsed.replyTo;
  if (!replyTo || typeof replyTo !== 'object') return content;
  const rt = replyTo as { text?: unknown; sender?: unknown; id?: unknown };
  const existingText = typeof rt.text === 'string' ? rt.text.trim() : '';
  const platformId = typeof rt.id === 'string' ? rt.id : '';
  if (existingText || !platformId) return content;

  const found = lookup(platformId);
  if (!found?.text) return content;
  parsed.replyTo = {
    ...rt,
    text: found.text,
    ...(typeof rt.sender === 'string' && rt.sender ? {} : found.sender ? { sender: found.sender } : {}),
  };
  return JSON.stringify(parsed);
}

function hydrateReplyContext(agentGroupId: string, sessionId: string, content: string): string {
  return hydrateReplyContextContent(content, (platformId) => {
    const db = openSession(agentGroupId, sessionId);
    try {
      return lookupQuotedMessageByPlatformId(db, platformId);
    } finally {
      db.close();
    }
  });
}

export type SenderResolverFn = (event: InboundEvent) => string | null;
export type AccessGateResult = { allowed: true } | { allowed: false; reason: string };
export type AccessGateFn = (
  event: InboundEvent,
  userId: string | null,
  group: MessagingGroup,
  agentId: string,
) => AccessGateResult;
let senderResolver: SenderResolverFn | null = null;
let accessGate: AccessGateFn | null = null;
export const setSenderResolver = (resolver: SenderResolverFn): void => {
  senderResolver = resolver;
};
export const setAccessGate = (gate: AccessGateFn): void => {
  accessGate = gate;
};

/**
 * Hook: decide what an unwired direct message means.
 *
 *   'wired'   — the sender is configured; a wiring was created, so re-read and deliver this message.
 *   'refused' — it is a DM and the sender is not configured. The hook has already recorded and
 *               reported it; the router must drop it *without* escalating.
 *   'skip'    — not a DM, or the sender could not be identified. Falls through to channel approval.
 *
 * The 'refused' case is why this returns three values rather than a boolean. A stranger's DM to a
 * fresh bot otherwise reached the channel-approval card, which asks the owner the wrong question:
 * "connect this chat?" — and answering yes wires it and *still* refuses the sender, because admission
 * is the roster. Whether to listen in a room is a real question; whether to talk to one person in
 * their own DM is already answered in config.
 */
export type RosterDmVerdict = 'wired' | 'refused' | 'skip';
export type RosterDmGateFn = (mg: MessagingGroup, event: InboundEvent) => RosterDmVerdict;

let rosterDmGate: RosterDmGateFn | null = null;

export function setRosterDmGate(fn: RosterDmGateFn): void {
  if (rosterDmGate) {
    log.warn('Roster DM gate overwritten');
  }
  rosterDmGate = fn;
}

export type ChannelRequestGateFn = (group: MessagingGroup, event: InboundEvent) => Promise<void>;
let channelRequestGate: ChannelRequestGateFn | null = null;
export const setChannelRequestGate = (gate: ChannelRequestGateFn): void => {
  channelRequestGate = gate;
};

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
function refreshGroup(event: InboundEvent) {
  return getMessagingGroupWithAgentCount(event.channelType, event.platformId);
}

async function selectMessagingGroup(event: InboundEvent): Promise<MessagingGroup | undefined> {
  let target = refreshGroup(event);
  if (!target) {
    if (!event.message.isMention) return;
    const group: MessagingGroup = {
      id: `mg-${randomUUID()}`,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: Number(Boolean(event.message.isGroup)),
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(group);
    target = { mg: group, agentCount: 0 };
  }
  if (target.agentCount) return target.mg;
  if (event.channelType === 'cli') {
    try {
      ensureCliWiring();
      target = refreshGroup(event) ?? target;
    } catch (err) {
      log.error('Could not wire the local channel', { err });
      return;
    }
    if (target.agentCount) return target.mg;
  }
  if (!event.message.isMention || target.mg.denied_at) return;
  const decision = rosterDmGate?.(target.mg, event);
  if (decision === 'refused') return;
  if (decision === 'wired') {
    target = refreshGroup(event) ?? target;
    if (target.agentCount) return target.mg;
  }
  const sender = safeParseContent(event.message.content).sender ?? null;
  recordDroppedMessage({
    channel_type: event.channelType,
    platform_id: event.platformId,
    sender_name: sender,
    user_id: null,
    reason: 'no_agent_wired',
    messaging_group_id: target.mg.id,
    agent_group_id: null,
  });
  if (channelRequestGate) {
    void channelRequestGate(target.mg, event).catch((err) => log.error('Channel approval request failed', { err }));
  } else log.warn('Unwired channel has no approval handler', { messagingGroupId: target.mg.id });
}

function evaluateEngage(
  wiring: MessagingGroupAgent,
  text: string,
  mentioned: boolean,
  group: MessagingGroup,
  thread: string | null,
): boolean {
  if (wiring.engage_mode === 'mention') return mentioned;
  if (wiring.engage_mode === 'mention-sticky') {
    return (
      mentioned || (Boolean(group.is_group) && Boolean(findSessionForAgent(wiring.agent_group_id, group.id, thread)))
    );
  }
  if (wiring.engage_mode !== 'pattern') return false;
  // "." is the documented always-on pattern, but as a regex it needs one character to match. An
  // uncaptioned file, photo or forward has no text at all, so it was dropped from always-on chats.
  const pattern = wiring.engage_pattern ?? '.';
  if (pattern === '.') return true;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return true;
  }
}

export async function routeInbound(received: InboundEvent): Promise<void> {
  const adapter = getChannelAdapter(received.channelType);
  let event = adapter && !adapter.supportsThreads ? { ...received, threadId: null } : received;
  const group = await selectMessagingGroup(event);
  if (!group) return;
  const userId = senderResolver?.(event) ?? null;
  const authorized = getMessagingGroupAgents(group.id).flatMap((wiring) => {
    const agent = getAgentGroup(wiring.agent_group_id);
    if (!agent || (accessGate && !accessGate(event, userId, group, wiring.agent_group_id).allowed)) return [];
    return [{ wiring, agent }];
  });
  if (!authorized.length) return;
  try {
    const content = await transcribeInboundContent(event.message.content);
    event = { ...event, message: { ...event.message, content } };
  } catch (err) {
    log.error('Could not transcribe inbound audio', { err });
  }
  const parsed = safeParseContent(event.message.content);
  let routed = 0;
  let subscriptionRequested = false;
  for (const { wiring, agent } of authorized) {
    const engages = evaluateEngage(wiring, parsed.text ?? '', event.message.isMention === true, group, event.threadId);
    if (!engages && wiring.ignored_message_policy !== 'accumulate') continue;
    await deliverToAgent(wiring, agent, group, event, userId, adapter?.supportsThreads === true, engages);
    routed++;
    if (
      engages &&
      !subscriptionRequested &&
      wiring.engage_mode === 'mention-sticky' &&
      group.is_group &&
      event.threadId !== null &&
      adapter?.supportsThreads &&
      adapter.subscribe
    ) {
      subscriptionRequested = true;
      void adapter
        .subscribe(event.platformId, event.threadId)
        .catch((err) => log.warn('Thread subscription failed', { err }));
    }
  }
  if (!routed)
    recordDroppedMessage({
      channel_type: event.channelType,
      platform_id: event.platformId,
      user_id: userId,
      sender_name: parsed.sender ?? null,
      reason: 'no_agent_engaged',
      messaging_group_id: group.id,
      agent_group_id: null,
    });
}

async function deliverToAgent(
  agent: MessagingGroupAgent,
  agentGroup: AgentGroup,
  mg: MessagingGroup,
  event: InboundEvent,
  userId: string | null,
  adapterSupportsThreads: boolean,
  wake: boolean,
): Promise<void> {
  const mode =
    adapterSupportsThreads && agent.session_mode !== 'agent-shared' && mg.is_group ? 'per-thread' : agent.session_mode;
  const selected = event.ephemeral
    ? createEphemeralSession(agent.agent_group_id, mg.id, event.threadId)
    : resolveSession(agent.agent_group_id, mg.id, event.threadId, mode);
  const { session, created } = selected;
  const deliveryAddr = event.replyTo ?? event;

  // Command gate: classify slash commands before they reach the container.
  // Filtered commands are dropped silently. Denied owner commands get a
  // permission-denied response written directly to messages_out. Unknown
  // slash commands get a "not recognized" reply and never wake the agent.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const gate = gateCommand(event.message.content, userId);
    if (gate.action === 'filter') {
      log.debug('Filtered command dropped by gate', { agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'help') {
      sendHostReply(session.agent_group_id, session.id, {
        id: `help-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: renderCommandHelp(userId !== null && isOwner(userId)), plain: true }),
      });
      return;
    }
    if (gate.action === 'deny') {
      sendHostReply(session.agent_group_id, session.id, {
        id: `deny-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Permission denied: ${gate.command} requires owner access.` }),
      });
      log.info('Admin command denied by gate', { command: gate.command, userId, agentGroupId: agent.agent_group_id });
      return;
    }
    if (gate.action === 'unrecognized') {
      sendHostReply(session.agent_group_id, session.id, {
        id: `unrecognized-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: `Command not recognized: ${gate.command}` }),
      });
      log.info('Unrecognized command rejected by gate', {
        command: gate.command,
        userId,
        agentGroupId: agent.agent_group_id,
      });
      return;
    }
    if (gate.action === 'pass' && gate.command === '/kill') {
      log.info('User requested /kill, killing container', {
        sessionId: session.id,
        agentGroupId: agent.agent_group_id,
      });

      // Cancel in-flight claims so host-sweep does not retry them as crash recovery.
      try {
        const db = openSession(session.agent_group_id, session.id);
        try {
          completeAllProcessing(db);
        } finally {
          db.close();
        }
      } catch (err) {
        log.warn('Failed to complete processing rows on /kill', { err });
      }

      killContainer(session.id, 'user-requested-kill');

      sendHostReply(session.agent_group_id, session.id, {
        id: `kill-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: deliveryAddr.platformId,
        channelType: deliveryAddr.channelType,
        threadId: deliveryAddr.threadId,
        content: JSON.stringify({ text: 'Agent killed.' }),
      });
      return;
    }
    if (gate.action === 'pass' && gate.command === '/restart') {
      log.info('User requested /restart, rebuilding and restarting container', {
        sessionId: session.id,
        agentGroupId: agent.agent_group_id,
      });

      void (async () => {
        try {
          const { readStoredContainerConfig, writeStoredContainerConfig } = await import('./container-config.js');
          const { isContainerRunning } = await import('./container-runner.js');

          const stored = readStoredContainerConfig(agentGroup);
          const aptPackages = stored.packages.apt;
          const npmPackages = stored.packages.npm;
          // A rebuild only happens when this group has extra packages layered on the base image.
          // Saying "rebuilding" on an install with none of those promised work that never ran.
          const willRebuild = aptPackages.length > 0 || npmPackages.length > 0;
          const wasRunning = isContainerRunning(session.id);

          sendHostReply(session.agent_group_id, session.id, {
            id: `restart-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text: willRebuild ? 'Rebuilding the image, then restarting the agent…' : 'Restarting the agent…',
            }),
          });

          if (!willRebuild) {
            if (stored.imageTag) {
              const { imageTag: _removed, ...rest } = stored;
              writeStoredContainerConfig(rest);
            }
          } else {
            const { buildAgentGroupImage } = await import('./container-runner.js');
            await buildAgentGroupImage(agent.agent_group_id);
          }

          // Wait for the container to actually go, then for its replacement to come up.
          //
          // This used to report success immediately: `killContainer` is fire-and-forget, so the
          // "restarted successfully" line was written microseconds after the kill was *requested* —
          // before the old container had stopped, never mind a new one starting. A sub-second
          // "done" for an operation that takes tens of seconds is not a status, it is a guess, and
          // when nothing was running at all it was a guess about work that never happened.
          const restarted = await restartSessionContainer(session.id);

          sendHostReply(session.agent_group_id, session.id, {
            id: `restart-done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text: !wasRunning
                ? `${willRebuild ? 'Image rebuilt. ' : ''}No agent was running — the next message starts a fresh one.`
                : restarted
                  ? `${willRebuild ? 'Image rebuilt and agent restarted.' : 'Agent restarted.'}`
                  : `${willRebuild ? 'Image rebuilt. ' : ''}The old agent stopped, but the new one did not come up — the next message will retry.`,
            }),
          });
        } catch (err) {
          log.error('Failed to rebuild and restart agent', { err });
          sendHostReply(session.agent_group_id, session.id, {
            id: `restart-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text: `Failed to rebuild agent: ${err instanceof Error ? err.message : String(err)}`,
            }),
          });
        }
      })();

      return;
    }
    if (gate.action === 'pass' && gate.command === '/tasks') {
      try {
        const { formatScheduledTaskList } = await import('./modules/scheduling/command.js');
        sendHostReply(session.agent_group_id, session.id, {
          id: `tasks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          platformId: deliveryAddr.platformId,
          channelType: deliveryAddr.channelType,
          threadId: deliveryAddr.threadId,
          content: JSON.stringify({ text: formatScheduledTaskList(), plain: true }),
        });
      } catch (err) {
        log.error('Failed to list scheduled tasks', { err });
        sendHostReply(session.agent_group_id, session.id, {
          id: `tasks-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          platformId: deliveryAddr.platformId,
          channelType: deliveryAddr.channelType,
          threadId: deliveryAddr.threadId,
          content: JSON.stringify({ text: 'Could not list scheduled tasks.', plain: true }),
        });
      }
      return;
    }
    if (gate.action === 'pass' && gate.command && MEMORY_COMMANDS.has(gate.command)) {
      // Answered by the host, against the memory service directly. These used to run in the
      // container against a mounted knowledge base and its own binary, neither of which exists
      // any more — so all of them answered "the knowledge base is not available". Host-side they
      // also answer while the container is down, which is when looking something up by hand is
      // most useful.
      const command = gate.command;
      const argument = commandArgument(event.message.content, command);
      void (async () => {
        const { runMemoryCommand } = await import('./memory/commands.js');
        const result = await runMemoryCommand(command, argument, {
          agentGroupId: session.agent_group_id,
          sessionId: session.id,
        });

        // `/download` answers with several rows, one per file: the Telegram adapter throws on a
        // message carrying two uploads, and it throws inside delivery, so a single multi-file row
        // never lands and the sweep retries it until its attempt budget is gone.
        const rows = typeof result === 'string' ? [{ text: result }] : result;
        for (const row of rows) {
          sendHostReply(session.agent_group_id, session.id, {
            // A row carrying files must use the id naming its outbox directory, or delivery looks
            // for the attachments somewhere they are not and sends the caption alone.
            id: row.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify(row.files ? { text: row.text, files: row.files } : { text: row.text }),
          });
        }
      })();

      return;
    }
    if (gate.action === 'pass' && gate.command === '/report') {
      // Recorded by the host, not the agent. A complaint about the agent that the agent has to
      // write down is one lost exactly when it matters — a container that is wedged, looping, or
      // answering nonsense is the case this exists for.
      const complaint = commandArgument(event.message.content, '/report');
      void (async () => {
        try {
          const { createReport } = await import('./db/reports.js');
          const report = createReport({
            id: `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            session_id: session.id,
            agent_group_id: session.agent_group_id,
            messaging_group_id: mg.id,
            user_id: userId,
            complaint: complaint || '(no description given)',
            context: recentExchange(session.agent_group_id, session.id),
          });
          log.info('Session reported', { sessionId: session.id, reportId: report.id, userId });
          sendHostReply(session.agent_group_id, session.id, {
            id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text:
                `📝 Reported — \`${report.id}\`.` +
                (complaint
                  ? ''
                  : '\n\nAdd a description next time (`/report it answered the wrong page`) — it is what makes the report actionable.'),
              plain: true,
            }),
          });
        } catch (err) {
          log.error('Failed to record report', { err, sessionId: session.id });
          sendHostReply(session.agent_group_id, session.id, {
            id: `report-err-${Date.now()}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text: 'Could not record that report — it is in the host log instead.',
              plain: true,
            }),
          });
        }
      })();

      return;
    }
    if (gate.action === 'pass' && gate.command === '/health') {
      log.info('User requested /health', {
        sessionId: session.id,
        agentGroupId: agent.agent_group_id,
        userId,
      });

      void (async () => {
        try {
          const { collectHealthReport, formatHealthMarkdown } = await import('./health-report.js');
          const report = await collectHealthReport();
          sendHostReply(session.agent_group_id, session.id, {
            id: `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            // Rich markdown — GFM table + emoji (do not set plain: true)
            content: JSON.stringify({ text: formatHealthMarkdown(report) }),
          });
        } catch (err) {
          log.error('Failed to collect health report', { err });
          sendHostReply(session.agent_group_id, session.id, {
            id: `health-err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platformId: deliveryAddr.platformId,
            channelType: deliveryAddr.channelType,
            threadId: deliveryAddr.threadId,
            content: JSON.stringify({
              text: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
              plain: true,
            }),
          });
        }
      })();

      return;
    }
  }

  const messageInId = `${event.message.id || generateId()}:${agent.agent_group_id}`;
  const content = stampInboundPrivilege(
    hydrateReplyContext(session.agent_group_id, session.id, event.message.content),
    userId,
    { episodesEnabled: !event.ephemeral && !mg.is_group },
  );
  writeSessionMessage(agent.agent_group_id, session.id, {
    id: messageInId,
    content,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    trigger: wake ? 1 : 0,
    channelType: deliveryAddr.channelType,
    platformId: deliveryAddr.platformId,
    threadId: deliveryAddr.threadId,
  });

  // Queue the RAW user text for memory to digest after the turn — before context/reply hydration,
  // so enrichment never reaches memory. Nothing here calls a model: routing an inbound message must
  // not wait on one. The sweep drains the queue.
  try {
    const eligibility = evaluateEligibility({
      messagingGroup: mg,
      userId,
      kind: event.message.kind,
      rawContent: event.message.content,
    });
    if (eligibility.eligible && eligibility.text) {
      const db = openSession(session.agent_group_id, session.id);
      try {
        const forwarded = forwardedFrom(event.message.content);
        const reply = repliedTo(event.message.content);
        const speaker = rosterUser(userId ? resolveUserKey(userId) : null)?.name;
        const eventAt = Date.parse(event.message.timestamp);
        notePendingDigest(db, {
          itemId: messageInId,
          text: eligibility.text,
          ...(speaker ? { speaker } : {}),
          ...(forwarded ? { forwardedFrom: forwarded } : {}),
          ...(reply ? { replyTo: reply } : {}),
          at: Number.isFinite(eventAt) ? eventAt : Date.now(),
        });
      } finally {
        db.close();
      }
    } else if (eligibility.reason === 'secret_detected') {
      // Worth a line: the message looked like a credential and was deliberately not learned from.
      log.info('memory digest skipped — the message looked like a credential', { sessionId: session.id });
    } else if (eligibility.reason === 'too_large') {
      log.warn('memory digest skipped — one source item exceeded the retain protocol limit', {
        sessionId: session.id,
        messageInId,
      });
    }
  } catch (err) {
    log.warn('memory digest queue failed', { sessionId: session.id, messageInId, err });
  }

  log.info('Inbound queued', {
    sessionId: session.id,
    agentGroup: agent.agent_group_id,
    agentGroupName: agentGroup.name,
    kind: event.message.kind,
    userId,
    created,
    wake,
  });
  if (!wake) return;
  startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);
  const current = getSession(session.id);
  if (!current || !(await wakeContainer(current))) stopTypingRefresh(session.id);
}
