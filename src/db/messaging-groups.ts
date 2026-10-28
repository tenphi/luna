import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import { createDestination, getDestinations, normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import { getDb } from './connection.js';
import { deleteRecords, findRecord, findRecords, insertRecord, pickRecord, updateRecords } from './records.js';

export function createMessagingGroup(group: MessagingGroup): void {
  insertRecord(
    getDb(),
    'messaging_groups',
    pickRecord(group, ['id', 'channel_type', 'platform_id', 'name', 'is_group', 'created_at', 'denied_at']),
  );
}
export const getMessagingGroup = (id: string): MessagingGroup | undefined =>
  findRecord(getDb(), 'messaging_groups', { id });
export const getMessagingGroupByPlatform = (channel: string, platform: string): MessagingGroup | undefined =>
  findRecord(getDb(), 'messaging_groups', { channel_type: channel, platform_id: platform });
export function getMessagingGroupWithAgentCount(
  channel: string,
  platform: string,
): { mg: MessagingGroup; agentCount: number } | null {
  const record = getDb()
    .prepare(
      `SELECT messaging_groups.*, (SELECT count(*) FROM messaging_group_agents WHERE messaging_group_id=messaging_groups.id) AS wired
    FROM messaging_groups WHERE channel_type=? AND platform_id=?`,
    )
    .get(channel, platform) as (MessagingGroup & { wired: number }) | undefined;
  if (!record) return null;
  const { wired, ...mg } = record;
  return { mg, agentCount: wired };
}
export function updateMessagingGroup(id: string, change: Partial<Pick<MessagingGroup, 'name' | 'is_group'>>): void {
  updateRecords(getDb(), 'messaging_groups', pickRecord(change, ['name', 'is_group']), 'id=?', [id]);
}
export const deleteMessagingGroup = (id: string): void => deleteRecords(getDb(), 'messaging_groups', { id });
export function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): void {
  updateRecords(getDb(), 'messaging_groups', { denied_at: deniedAt }, 'id=?', [id]);
}

/** Wiring and its outbound destination are committed together. Refresh running sessions after edits. */
export function createMessagingGroupAgent(wiring: MessagingGroupAgent): void {
  getDb().transaction(() => {
    insertRecord(getDb(), 'messaging_group_agents', { ...wiring });
    const destinations = getDestinations(wiring.agent_group_id);
    if (destinations.some((entry) => entry.target_type === 'channel' && entry.target_id === wiring.messaging_group_id))
      return;
    const chat = getMessagingGroup(wiring.messaging_group_id);
    if (!chat) return;
    const base = normalizeName(chat.name || `${chat.channel_type}-${chat.id.slice(0, 8)}`);
    const names = new Set(destinations.map((entry) => entry.local_name));
    let name = base;
    for (let suffix = 2; names.has(name); suffix++) name = `${base}-${suffix}`;
    createDestination({
      agent_group_id: wiring.agent_group_id,
      target_type: 'channel',
      target_id: chat.id,
      local_name: name,
      created_at: wiring.created_at,
    });
  })();
}
export const getMessagingGroupAgents = (group: string): MessagingGroupAgent[] =>
  findRecords(
    getDb(),
    'messaging_group_agents',
    { messaging_group_id: group },
    { column: 'priority', descending: true },
  );
export const getMessagingGroupAgentByPair = (group: string, agent: string): MessagingGroupAgent | undefined =>
  findRecord(getDb(), 'messaging_group_agents', { messaging_group_id: group, agent_group_id: agent });
export const getMessagingGroupAgent = (id: string): MessagingGroupAgent | undefined =>
  findRecord(getDb(), 'messaging_group_agents', { id });
export function updateMessagingGroupAgent(
  id: string,
  change: Partial<
    Pick<MessagingGroupAgent, 'engage_mode' | 'engage_pattern' | 'ignored_message_policy' | 'session_mode' | 'priority'>
  >,
): void {
  updateRecords(
    getDb(),
    'messaging_group_agents',
    pickRecord(change, ['engage_mode', 'engage_pattern', 'ignored_message_policy', 'session_mode', 'priority']),
    'id=?',
    [id],
  );
}
export const deleteMessagingGroupAgent = (id: string): void => deleteRecords(getDb(), 'messaging_group_agents', { id });
