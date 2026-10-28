/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export function restartAgentGroupContainers(agentGroupId: string, reason: string, wakeMessage?: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: 1,
      });
    }
    killContainer(
      session.id,
      reason,
      wakeMessage
        ? () => {
            const s = getSession(session.id);
            if (s) wakeContainer(s);
          }
        : undefined,
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}

/**
 * Restart one session's container and wait for the result.
 *
 * `killContainer` is fire-and-forget: it asks the container to stop and returns, so a caller that
 * reports success on the next line reports it microseconds after asking — before the old container
 * has gone, never mind a new one being up. `/restart` did exactly that, which is why it answered in
 * under a second for an operation that takes tens of seconds, and answered the same way when
 * nothing had been running at all.
 *
 * Resolves `true` once a replacement is up, `false` if the old one stopped and the new one did not.
 * Both are honest answers; neither is instant. `false` is not a dead end — the next inbound message
 * wakes a container through the normal path.
 */
export async function restartSessionContainer(sessionId: string, timeoutMs = 60_000): Promise<boolean> {
  if (!isContainerRunning(sessionId)) return false;

  const stopped = new Promise<void>((resolve) => {
    killContainer(sessionId, 'user-requested-restart', resolve);
    // A container that will not die must not hold the reply open forever. The wake below is still
    // attempted: spawning over a container that is on its way out is the same race the normal
    // wake path already handles.
    setTimeout(resolve, timeoutMs).unref?.();
  });
  await stopped;

  const session = getSession(sessionId);
  if (!session) return false;
  return wakeContainer(session);
}
