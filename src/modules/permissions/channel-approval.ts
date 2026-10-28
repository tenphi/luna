import { normalizeOptions } from '../../channels/ask-question.js';
import { getTheAgent } from '../../bootstrap.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, updateMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  createPendingChannelApproval,
  deletePendingChannelApproval,
  hasInFlightChannelApproval,
} from './db/pending-channel-approvals.js';
export const CONNECT_PREFIX = 'connect:';
export const REJECT_VALUE = 'reject';
export type RequestChannelApprovalInput = { event: InboundEvent; messagingGroupId: string };
const resolving = new Set<string>();

export async function requestChannelApproval({
  event,
  messagingGroupId: id,
}: RequestChannelApprovalInput): Promise<void> {
  if (resolving.has(id) || hasInFlightChannelApproval(id)) return;
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  resolving.add(id);
  try {
    const agent = getTheAgent();
    const group = getMessagingGroup(id);
    if (!group) return;
    if (!group.name) {
      try {
        const name = await getChannelAdapter(group.channel_type)?.resolveChannelName?.(group.platform_id);
        if (name) {
          updateMessagingGroup(id, { name });
          group.name = name;
        }
      } catch {
        /* Channel names are optional presentation metadata. */
      }
    }
    const approver = await pickApprovalDelivery(pickApprover(), group.channel_type);
    if (!approver) return;
    const options = normalizeOptions([
      {
        value: `${CONNECT_PREFIX}${agent.id}`,
        label: `Connect to ${agent.name}`,
        selectedLabel: `✅ Connected to ${agent.name}`,
      },
      { value: REJECT_VALUE, label: 'Reject', selectedLabel: '🙅 Rejected' },
    ]);
    const isGroup = event.message.isGroup ?? Boolean(group.is_group);
    const title = isGroup ? 'Connect this group?' : 'Connect this conversation?';
    createPendingChannelApproval({
      messaging_group_id: id,
      agent_group_id: agent.id,
      approver_user_id: approver.userId,
      original_message: JSON.stringify(event),
      created_at: new Date().toISOString(),
      title,
      options_json: JSON.stringify(options),
    });
    try {
      await adapter.deliver(
        approver.messagingGroup.channel_type,
        approver.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: id,
          title,
          options,
          question: `Allow Luna in ${group.name ?? 'this conversation'} on ${group.channel_type}? Only people in your configured roster will receive answers.`,
        }),
      );
    } catch (error) {
      deletePendingChannelApproval(id);
      log.warn('Channel approval could not be delivered', { messagingGroupId: id, error });
    }
  } catch (error) {
    log.warn('Channel approval could not be prepared', { messagingGroupId: id, error });
  } finally {
    resolving.delete(id);
  }
}
