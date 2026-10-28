/**
 * Test-only helpers for wiring the in-memory SessionClient.
 *
 * Container tests seed and assert against an InMemorySessionClient instead of
 * a real SQLite file — there is no SQLite in the container production path
 * anymore, and no live host is needed for unit tests.
 */
import { InMemorySessionClient, setSessionClient, type DestRow } from './client.js';

/** Install a fresh in-memory client as the process-wide singleton. */
export function installTestSessionClient(): InMemorySessionClient {
  const client = new InMemorySessionClient();
  setSessionClient(client);
  return client;
}

/** Detach the test client so later code re-selects the HTTP client. */
export function resetTestSessionClient(): void {
  setSessionClient(null);
}

/** Convenience: push a channel destination row onto an in-memory client. */
export function seedChannelDestination(
  client: InMemorySessionClient,
  row: Partial<DestRow> & { name: string; channel_type: string; platform_id: string },
): void {
  client.destinations.push({
    name: row.name,
    display_name: row.display_name ?? row.name,
    type: 'channel',
    channel_type: row.channel_type,
    platform_id: row.platform_id,
    agent_group_id: null,
  });
}
