/**
 * Default reply routing for this session — owned and written by the host.
 *
 * Read by the MCP tools as the default destination for outbound messages when
 * the agent doesn't specify an explicit `to`. Fetched over the SessionClient.
 */
import { getSessionClient, type SessionRouting } from '../session/client.js';

export type { SessionRouting };

export async function getSessionRouting(): Promise<SessionRouting> {
  try {
    return await getSessionClient().getSessionRouting();
  } catch {
    return { channel_type: null, platform_id: null, thread_id: null };
  }
}
