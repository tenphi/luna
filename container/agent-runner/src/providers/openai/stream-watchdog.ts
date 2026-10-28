/**
 * Idle watchdog for a streaming completion.
 *
 * Wraps the SSE iterator and does two things the underlying stream can't:
 *
 *   - Ticks while we wait. Luna's liveness heartbeat is driven by provider
 *     events, so a completion that takes a while to produce its first token
 *     looks identical to a wedged container and the host sweep kills it ~60s
 *     after the claim. Waiting is not the same as being dead.
 *
 *   - Gives up eventually. A half-open connection or a stalled gateway keeps
 *     the socket open and stops sending; there is no error and no end of
 *     stream, so `for await` waits forever. Aborting lets the caller's retry
 *     loop start a fresh request, which is cheap next to losing the container.
 */
import { StreamIdleError } from '../format-error.js';

/**
 * Heartbeat cadence while a stream is silent. Comfortably inside the sweep's
 * 60s per-claim tolerance without adding meaningful RPC traffic.
 */
export const STREAM_HEARTBEAT_MS = 5_000;

const TICK = Symbol('tick');

/**
 * A signal that fires when either input does.
 *
 * `AbortSignal.any` holds its sources weakly, so composing per request costs
 * nothing across a long agent loop. The fallback listener does leak until the
 * turn's signal is collected, which only matters on runtimes old enough not to
 * have the standard method.
 */
export function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([a, b]);

  const controller = new AbortController();
  for (const source of [a, b]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

export interface IdleWatchdogOptions {
  /** Abort after this much silence. 0 disables the deadline (ticks continue). */
  idleMs: number;
  /** How often to call `onTick` while waiting. */
  tickMs?: number;
  onTick?: () => void;
  /**
   * Cancel the underlying request. Closing the iterator is not enough: an async
   * iterator queues `return()` behind the `next()` we are already waiting on,
   * which is precisely the call that will never settle. The caller aborts the
   * request signal instead.
   */
  onIdle?: () => void;
}

/**
 * Yield from `source`, ticking during quiet stretches and throwing
 * `StreamIdleError` once one exceeds `idleMs`.
 */
export async function* withIdleWatchdog<T>(
  source: AsyncIterable<T>,
  opts: IdleWatchdogOptions,
): AsyncGenerator<T> {
  const tickMs = Math.max(1, opts.tickMs ?? STREAM_HEARTBEAT_MS);
  const it = source[Symbol.asyncIterator]();

  try {
    while (true) {
      const pending = it.next();
      let idleFor = 0;
      let result: IteratorResult<T> | undefined;

      while (result === undefined) {
        const remaining = opts.idleMs > 0 ? opts.idleMs - idleFor : Number.POSITIVE_INFINITY;
        const step = Math.min(tickMs, remaining);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof TICK>((resolve) => {
          timer = setTimeout(() => resolve(TICK), step);
        });
        const raced = await Promise.race([pending, tick]);
        if (timer) clearTimeout(timer);

        if (raced !== TICK) {
          result = raced;
          break;
        }

        idleFor += step;
        opts.onTick?.();

        if (opts.idleMs > 0 && idleFor >= opts.idleMs) {
          // The pending `next()` outlives this frame; without a handler the
          // rejection the abort provokes is unhandled and Bun takes the
          // process down with it.
          void pending.catch(() => {});
          opts.onIdle?.();
          throw new StreamIdleError(idleFor);
        }
      }

      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Best-effort for the ordinary early-break case; on the idle path the
    // abort in `onIdle` is what actually frees the connection.
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}
