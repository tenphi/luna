import { randomUUID } from 'node:crypto';
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getTheAgent } from '../../bootstrap.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroup,
  setMessagingGroupDeniedAt,
} from '../../db/messaging-groups.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  setRosterDmGate,
  setSenderResolver,
  type AccessGateResult,
  type RosterDmVerdict,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import { notifyOwnerOfUnknownSender } from './roster-notice.js';
import { CONNECT_PREFIX, REJECT_VALUE, requestChannelApproval } from './channel-approval.js';
import { deletePendingChannelApproval, getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { isOwner, resolveUserKey } from '../../users/binding.js';
import { normalizeTelegramHandle, rosterUser } from '../../users/roster.js';
import { getUser, setUserDisplayName, upsertUser } from './db/users.js';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = object(JSON.parse(event.message.content));
  } catch {
    return null;
  }
  const author = object(content.author);
  const raw = text(content.senderId) ?? text(content.sender) ?? text(author.userId);
  if (!raw) return null;
  const id = raw.includes(':') ? raw : `${event.channelType}:${raw}`;
  const previous = getUser(id);
  const name = text(content.senderName) ?? text(author.fullName) ?? text(author.userName);
  const username = normalizeTelegramHandle(text(author.userName));
  if (!previous || (username && previous.platform_username !== username) || (name && !previous.display_name)) {
    upsertUser({
      id,
      kind: previous?.kind ?? event.channelType,
      display_name: name ?? previous?.display_name ?? null,
      platform_username: username ?? previous?.platform_username ?? null,
      created_at: previous?.created_at ?? new Date().toISOString(),
    });
  }
  const key = resolveUserKey(id);
  const configured = rosterUser(key)?.name;
  if (configured && configured !== key && configured !== getUser(id)?.display_name) setUserDisplayName(id, configured);
  return id;
}
function safeParseContent(raw: string): { sender?: string } {
  try {
    return object(JSON.parse(raw));
  } catch {
    return {};
  }
}
function handleUnknownSender(
  group: MessagingGroup,
  userId: string | null,
  agentId: string | null,
  reason: string,
  event: InboundEvent,
): void {
  const senderName = safeParseContent(event.message.content).sender ?? null;
  recordDroppedMessage({
    user_id: userId,
    sender_name: senderName,
    reason: `not_in_roster_${reason}`,
    agent_group_id: agentId,
    messaging_group_id: group.id,
    channel_type: event.channelType,
    platform_id: event.platformId,
  });
  void notifyOwnerOfUnknownSender({
    channelType: event.channelType,
    userId,
    senderName,
    platformId: event.platformId,
    disabled: reason === 'user_disabled',
  }).catch((error) => log.warn('Could not send the roster notice', { error }));
}

setSenderResolver(extractAndUpsertUser);

/**
 * Decide what an unwired direct message means, and wire it when the sender is configured.
 *
 * The sender is resolved here rather than trusted from the event, because this runs before the access
 * gate — it is deciding whether there is anything to gate at all.
 */
setRosterDmGate((mg, event): RosterDmVerdict => {
  const userId = extractAndUpsertUser(event);
  if (!userId) return 'skip';

  // The chat must *be* this person's own DM address, not merely look like a non-group.
  //
  // `is_group` comes from `event.message.isGroup`, which the chat-sdk bridge does set — but relying on
  // it alone means a missing or wrong value auto-wires a *group* with `engage_pattern: '.'`: Luna
  // answering every message in a room it was never invited to reason about, on the strength of one
  // roster member being present. "The chat id is the sender's id" cannot be satisfied by a group, since
  // a Telegram group is one negative chat id shared by everyone in it.
  //
  // Both sides must also be on the same channel. `senderId` is caller-supplied on the CLI transport, so
  // it can name an identity from a different channel than the chat — and comparing only the parts after
  // the colon would let `telegram:222` look like the owner of chat `cli:222`.
  //
  // Channels whose DM address is not the user id fall through to the approval card, which is the safe
  // default rather than a missing feature.
  const bare = (value: string): string => (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
  const chatOnThisChannel = !event.platformId.includes(':') || event.platformId.startsWith(`${event.channelType}:`);
  const senderOnThisChannel = userId.startsWith(`${event.channelType}:`);
  const chatIsSender = chatOnThisChannel && senderOnThisChannel && bare(event.platformId) === bare(userId);
  if (!chatIsSender || event.message.isGroup === true) return 'skip';

  const key = resolveUserKey(userId);
  if (!key || !rosterUser(key)?.enabled) {
    // A DM from someone the roster does not admit. Report it as what it is — an unknown *person* —
    // rather than letting it fall through to "connect this chat?", which asks the owner a question
    // whose yes would wire the chat and still refuse the sender.
    //
    // No `getTheAgent()` here: it creates the default agent group as a side effect, and a stranger's
    // refused message must not be what brings one into existence.
    handleUnknownSender(mg, userId, null, key ? 'user_disabled' : 'unknown_user', event);
    return 'refused';
  }

  const ag = getTheAgent();
  if (getMessagingGroupAgentByPair(mg.id, ag.id)) return 'skip';

  createMessagingGroupAgent({
    id: `mga-${randomUUID()}`,
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    // A DM is a conversation, so answer everything in it — the same defaults `init-first-agent` uses
    // for the owner's own chat.
    engage_mode: 'pattern',
    engage_pattern: '.',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Wired a DM for a configured user', { messagingGroupId: mg.id, userId, key, agentGroupId: ag.id });
  return 'wired';
});

setAccessGate((event, userId, group, agentId): AccessGateResult => {
  const decision = userId ? canAccessAgentGroup(userId, agentId) : { allowed: false as const, reason: 'unknown_user' };
  if (!decision.allowed) handleUnknownSender(group, userId, agentId, decision.reason, event);
  return decision;
});

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});

async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const request = getPendingChannelApproval(payload.questionId);
  if (!request) return false;
  const actor = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  if (!actor || (actor !== request.approver_user_id && !isOwner(actor))) {
    log.warn('Unauthorized channel approval click', { messagingGroupId: request.messaging_group_id });
    return true;
  }
  if (payload.value === REJECT_VALUE) {
    setMessagingGroupDeniedAt(request.messaging_group_id, new Date().toISOString());
    deletePendingChannelApproval(request.messaging_group_id);
    return true;
  }
  if (!isOwner(actor) || payload.value !== `${CONNECT_PREFIX}${request.agent_group_id}`) return true;
  const agent = getAgentGroup(request.agent_group_id);
  const group = getMessagingGroup(request.messaging_group_id);
  if (!agent || !group) {
    deletePendingChannelApproval(request.messaging_group_id);
    return true;
  }
  let event: InboundEvent;
  try {
    event = JSON.parse(request.original_message) as InboundEvent;
  } catch {
    deletePendingChannelApproval(request.messaging_group_id);
    return true;
  }
  const grouped = event.message.isGroup ?? Boolean(group.is_group);
  if (!getMessagingGroupAgentByPair(group.id, agent.id))
    createMessagingGroupAgent({
      id: `mga-${randomUUID()}`,
      messaging_group_id: group.id,
      agent_group_id: agent.id,
      engage_mode: grouped ? 'mention-sticky' : 'pattern',
      engage_pattern: grouped ? null : '.',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  extractAndUpsertUser(event);
  deletePendingChannelApproval(group.id);
  try {
    await routeInbound(event);
  } catch (error) {
    log.error('Approved channel replay failed', { messagingGroupId: group.id, error });
  }
  return true;
}
registerResponseHandler(handleChannelApprovalResponse);
