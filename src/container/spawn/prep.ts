/**
 * Session prep before container spawn — destinations, routing, liveness reset.
 */
import { writeDestinations } from '../../modules/agent-to-agent/write-destinations.js';
import { clearLiveness } from '../../session-liveness.js';
import { writeSessionRouting } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';

export async function prepareSessionForSpawn(agentGroup: AgentGroup, session: Session): Promise<void> {
  writeDestinations(agentGroup.id, session.id);
  writeSessionRouting(agentGroup.id, session.id);
  // Drop any stale last-seen from a previous container so the sweep's ceiling
  // check waits for the new container's first ping instead of acting on old data.
  clearLiveness(session.id);
}
