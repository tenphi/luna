/**
 * Per-session liveness, tracked in-memory on the host.
 *
 * Replaces the old `.heartbeat` file mtime + `container_state` table. The
 * container pings the Session API (heartbeat on activity; tool-in-flight on
 * PreToolUse / cleared on PostToolUse). The host sweep and the typing module
 * read this map instead of stat-ing a file or querying a DB.
 *
 * State is intentionally ephemeral: on host restart every entry resets to
 * "never seen", which the sweep treats like a fresh spawn (grace period).
 */
export interface SessionLiveness {
  /** epoch ms of the last ping; 0 = never seen this process lifetime. */
  lastSeenMs: number;
  /** Tool currently in flight (e.g. "Bash"), or null. */
  tool: string | null;
  /** Declared timeout for the in-flight tool, or null. */
  toolDeclaredTimeoutMs: number | null;
  /** ISO timestamp when the current tool started, or null. */
  toolStartedAt: string | null;
}

const liveness = new Map<string, SessionLiveness>();

function ensure(sessionId: string): SessionLiveness {
  let entry = liveness.get(sessionId);
  if (!entry) {
    entry = { lastSeenMs: 0, tool: null, toolDeclaredTimeoutMs: null, toolStartedAt: null };
    liveness.set(sessionId, entry);
  }
  return entry;
}

/**
 * Record a liveness ping. Always bumps lastSeen. When `setTool` is true, also
 * updates the in-flight-tool fields (tool may be null to clear).
 */
export function recordPing(
  sessionId: string,
  info: {
    setTool?: boolean;
    tool?: string | null;
    toolDeclaredTimeoutMs?: number | null;
    toolStartedAt?: string | null;
  } = {},
): void {
  const entry = ensure(sessionId);
  entry.lastSeenMs = Date.now();
  if (info.setTool) {
    entry.tool = info.tool ?? null;
    entry.toolDeclaredTimeoutMs = info.toolDeclaredTimeoutMs ?? null;
    entry.toolStartedAt = info.toolStartedAt ?? null;
  }
}

/** Current liveness for a session, or null if never seen this lifetime. */
export function getLiveness(sessionId: string): SessionLiveness | null {
  return liveness.get(sessionId) ?? null;
}

/** Forget a session's liveness (on container exit). */
export function clearLiveness(sessionId: string): void {
  liveness.delete(sessionId);
}
