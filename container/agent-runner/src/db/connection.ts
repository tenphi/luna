/**
 * Liveness + in-flight-tool signalling.
 *
 * The container no longer opens SQLite over the mount — all session IO goes
 * through the SessionClient (see ../session/client.ts). The three helpers here
 * are fire-and-forget: callers stay synchronous and we swallow transport
 * errors, because a dropped heartbeat is self-healing (the next one lands, and
 * the host sweep only acts after a sustained silence).
 */
import { getSessionClient } from '../session/client.js';

/** Touch liveness so the host sweep knows the container is alive. */
export function touchHeartbeat(): void {
  void getSessionClient()
    .ping()
    .catch(() => {});
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when available (Bash exposes it); omit for tools with no
 * declared timeout. Host sweep widens its stuck tolerance while a long tool
 * is declared as running.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  void getSessionClient()
    .ping({ setTool: true, tool, toolDeclaredTimeoutMs: declaredTimeoutMs, toolStartedAt: new Date().toISOString() })
    .catch(() => {});
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  void getSessionClient()
    .ping({ setTool: true, tool: null, toolDeclaredTimeoutMs: null, toolStartedAt: null })
    .catch(() => {});
}
