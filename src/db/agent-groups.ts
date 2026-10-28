import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';
import { findRecord, insertRecord, updateRecords } from './records.js';

export const createAgentGroup = (group: AgentGroup): void => {
  insertRecord(getDb(), 'agent_groups', { ...group });
};
export const getAgentGroup = (id: string): AgentGroup | undefined => findRecord(getDb(), 'agent_groups', { id });
export const getAllAgentGroups = (): AgentGroup[] =>
  getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  updateRecords(getDb(), 'agent_groups', { name: updates.name, agent_provider: updates.agent_provider }, 'id=?', [id]);
}
export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id=?').run(id);
}
