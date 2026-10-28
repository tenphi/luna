import { randomUUID } from 'node:crypto';
import { namespacedPlatformId } from '../../platform-id.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getUser } from './db/users.js';
import { getUserDm, upsertUserDm } from './db/user-dms.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';

/** Resolve a known platform identity's DM without granting new access or wiring an agent. */
export async function ensureUserDm(userId: string): Promise<MessagingGroup | null> {
  const user = getUser(userId);
  if (!user) return null;
  const separator = user.id.indexOf(':');
  if (separator < 1 || separator === user.id.length - 1) return null;
  const prefix = user.id.slice(0, separator);
  let channel = prefix;
  let handle = user.id.slice(separator + 1);
  if (!getChannelAdapter(prefix) && user.kind && getChannelAdapter(user.kind)) {
    channel = user.kind;
    handle = user.id;
  }
  const cached = getUserDm(userId, channel);
  const existing = cached && getMessagingGroup(cached.messaging_group_id);
  if (existing) return existing;
  const adapter = getChannelAdapter(channel);
  if (!adapter) return null;
  try {
    const platform = adapter.openDM
      ? await adapter.openDM(handle)
      : channel === 'telegram'
        ? namespacedPlatformId(channel, handle)
        : handle;
    if (!platform) return null;
    const timestamp = new Date().toISOString();
    let group = getMessagingGroupByPlatform(channel, platform);
    if (!group) {
      group = {
        id: `mg-${randomUUID()}`,
        channel_type: channel,
        platform_id: platform,
        name: user.display_name,
        is_group: 0,
        created_at: timestamp,
      };
      createMessagingGroup(group);
    }
    upsertUserDm({ user_id: userId, channel_type: channel, messaging_group_id: group.id, resolved_at: timestamp });
    return group;
  } catch (error) {
    log.error('Could not resolve a private channel for the roster user', { channel, error });
    return null;
  }
}
