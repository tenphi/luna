/**
 * In-flight inbound routing, tracked so shutdown can wait for it.
 *
 * A channel adapter hands a message to `routeInbound` and moves on. Until that
 * promise settles the message exists only as a JS object in this process: no
 * row in any `session.db`, nothing for the host sweep to retry, and the
 * platform already considers it delivered. `process.exit(0)` in that window
 * loses the user's message with no trace at all. Registering every route here
 * lets shutdown give them a bounded chance to reach disk first.
 *
 * Tracking is deliberately not the same thing as backpressure: `routeInbound`
 * awaits the container spawn, so handing its promise back to a platform poller
 * that awaits its handlers would turn one slow spawn into head-of-line
 * blocking for every other chat.
 */
import { log } from './log.js';

const inFlight = new Set<Promise<void>>();

/** Register an inbound route. Rejections are the caller's to handle. */
export function trackInboundRouting(work: Promise<unknown>): void {
  const tracked = work.then(
    () => {},
    () => {},
  );
  inFlight.add(tracked);
  void tracked.finally(() => inFlight.delete(tracked));
}

export function inFlightInboundCount(): number {
  return inFlight.size;
}

/**
 * Wait for the currently-tracked routes to settle, up to `timeoutMs`.
 * Returns how many are still in flight — non-zero means we gave up on them.
 */
export async function drainInboundRouting(timeoutMs: number): Promise<number> {
  if (inFlight.size === 0) return 0;

  log.info('Draining in-flight inbound routing', { count: inFlight.size, timeoutMs });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });

  // Snapshot: a message that arrives mid-drain is reported as stranded rather
  // than extending the deadline.
  await Promise.race([Promise.all([...inFlight]).then(() => {}), deadline]);
  if (timer) clearTimeout(timer);

  return inFlight.size;
}
