import { AsyncLocalStorage } from 'async_hooks';

/**
 * Who is on the other end of a host-MCP call.
 *
 * Host builtins are constructed once per (agent group, server) and shared by every session
 * in that group, so a tool that needs to know *which* container is calling cannot capture it
 * at construction time — it has to read it per request. The supervisor establishes this
 * around `transport.handleRequest`, which is awaited inline, so a tool handler runs inside
 * the same async context as the HTTP request that carried it.
 *
 * **The group id is authenticated; the session id is a claim.** The bearer token is per
 * (group, server), so a container can name any session — but only of its own group. Nothing
 * here may use `sessionId` for anything but selecting a path *underneath* that group's own
 * directory, where the containment check is what actually enforces the boundary.
 */
export interface HostMcpCaller {
  agentGroupId: string;
  /** Absent for callers that predate the header, and for anything not spawned per session. */
  sessionId?: string;
}

const storage = new AsyncLocalStorage<HostMcpCaller>();

export function runAsCaller<T>(caller: HostMcpCaller, fn: () => T): T {
  return storage.run(caller, fn);
}

export function currentCaller(): HostMcpCaller | undefined {
  return storage.getStore();
}

/** The header the relay sends, so both ends name it once. */
export const SESSION_ID_HEADER = 'x-luna-session-id';
