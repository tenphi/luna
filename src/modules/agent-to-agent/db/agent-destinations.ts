import type { AgentDestination } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { insertRecord, findRecord } from '../../../db/records.js';

/** After edits, project destinations into each running session through writeDestinations. */
export function createDestination(destination: AgentDestination): void {
  insertRecord(getDb(), 'agent_destinations', { ...destination });
}
export function getDestinations(agentGroupId: string): AgentDestination[] {
  return getDb()
    .prepare('SELECT * FROM agent_destinations WHERE agent_group_id=?')
    .all(agentGroupId) as AgentDestination[];
}
export const getDestinationByTarget = (
  group: string,
  type: 'channel' | 'agent',
  id: string,
): AgentDestination | undefined =>
  findRecord<AgentDestination>(getDb(), 'agent_destinations', {
    agent_group_id: group,
    target_type: type,
    target_id: id,
  });
export const hasDestination = (group: string, type: 'channel' | 'agent', id: string): boolean =>
  getDestinationByTarget(group, type, id) !== undefined;
export const normalizeName = (name: string): string =>
  name
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('-') || 'unnamed';
