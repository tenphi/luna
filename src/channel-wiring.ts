import { randomUUID } from 'node:crypto';
import { namespacedPlatformId } from './platform-id.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import type { MessagingGroupAgent } from './types.js';

export function connectChannel(options: {
  agentId: string;
  channel: string;
  address: string;
  name: string;
  isGroup: boolean;
  pattern?: string;
  sessionMode?: MessagingGroupAgent['session_mode'];
}) {
  const address = namespacedPlatformId(options.channel, options.address);
  const createdAt = new Date().toISOString();
  let group = getMessagingGroupByPlatform(options.channel, address);
  if (!group) {
    const id = `mg-${randomUUID()}`;
    createMessagingGroup({
      id,
      channel_type: options.channel,
      platform_id: address,
      name: options.name,
      is_group: options.isGroup ? 1 : 0,
      created_at: createdAt,
    });
    group = getMessagingGroupByPlatform(options.channel, address)!;
  }
  const existing = getMessagingGroupAgentByPair(group.id, options.agentId);
  if (existing) return { group, newlyWired: false };
  const pattern = options.pattern || (group.is_group ? null : '.');
  createMessagingGroupAgent({
    id: `mga-${randomUUID()}`,
    agent_group_id: options.agentId,
    messaging_group_id: group.id,
    created_at: createdAt,
    priority: 0,
    session_mode: options.sessionMode ?? 'shared',
    ignored_message_policy: 'drop',
    engage_mode: pattern === null ? 'mention' : 'pattern',
    engage_pattern: pattern,
  });
  return { group, newlyWired: true };
}
