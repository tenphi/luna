import fs from 'node:fs';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { openSession, sessionDbPath } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

/** Refresh the host-owned projection consumed by the Session API. */
export function writeDestinations(agent: string, session: string): void {
  if (!fs.existsSync(sessionDbPath(agent, session))) return;
  const projected: DestinationRow[] = [];
  for (const destination of getDestinations(agent)) {
    const channel = destination.target_type === 'channel' ? getMessagingGroup(destination.target_id) : undefined;
    const group = destination.target_type === 'agent' ? getAgentGroup(destination.target_id) : undefined;
    if (!channel && !group) continue;
    projected.push({
      name: destination.local_name,
      display_name: channel?.name ?? group?.name ?? destination.local_name,
      type: destination.target_type,
      channel_type: channel?.channel_type ?? null,
      platform_id: channel?.platform_id ?? null,
      agent_group_id: group?.id ?? null,
    });
  }
  const database = openSession(agent, session);
  try {
    replaceDestinations(database, projected);
  } finally {
    database.close();
  }
}
