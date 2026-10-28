import { describe, expect, it } from 'bun:test';

import { isStreamIdleError } from '../format-error.js';
import { anySignal, withIdleWatchdog } from './stream-watchdog.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stream whose chunks arrive on a schedule, and which records early closure. */
function scheduledStream(gaps: number[], state: { closed: boolean }): AsyncIterable<number> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (let i = 0; i < gaps.length; i++) {
          await sleep(gaps[i]!);
          yield i;
        }
      } finally {
        state.closed = true;
      }
    },
  };
}

describe('withIdleWatchdog', () => {
  it('passes chunks through when the stream keeps producing', async () => {
    const state = { closed: false };
    const seen: number[] = [];
    for await (const chunk of withIdleWatchdog(scheduledStream([1, 1, 1], state), { idleMs: 200, tickMs: 5 })) {
      seen.push(chunk);
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(state.closed).toBe(true);
  });

  it('ticks while the stream is silent so the heartbeat keeps going', async () => {
    const state = { closed: false };
    let ticks = 0;
    const seen: number[] = [];
    for await (const chunk of withIdleWatchdog(scheduledStream([60], state), {
      idleMs: 5000,
      tickMs: 10,
      onTick: () => ticks++,
    })) {
      seen.push(chunk);
    }
    expect(seen).toEqual([0]);
    expect(ticks).toBeGreaterThan(1);
  });

  it('throws StreamIdleError and cancels the request once silence exceeds the deadline', async () => {
    const state = { closed: false };
    let cancelled = false;
    let err: unknown;
    try {
      for await (const _chunk of withIdleWatchdog(scheduledStream([10_000], state), {
        idleMs: 40,
        tickMs: 10,
        onIdle: () => {
          cancelled = true;
        },
      })) {
        // no chunk should ever arrive
      }
    } catch (e) {
      err = e;
    }

    expect(isStreamIdleError(err)).toBe(true);
    expect((err as { idleMs: number }).idleMs).toBeGreaterThanOrEqual(40);
    // The abort is the only thing that frees a stalled connection: the
    // iterator's own `return()` sits behind the `next()` that never settles.
    expect(cancelled).toBe(true);
    expect(state.closed).toBe(false);
  });

  it('measures silence per gap, not across the whole stream', async () => {
    const state = { closed: false };
    const seen: number[] = [];
    // Three gaps, each under the deadline; their sum is well over it.
    for await (const chunk of withIdleWatchdog(scheduledStream([30, 30, 30], state), { idleMs: 60, tickMs: 10 })) {
      seen.push(chunk);
    }
    expect(seen).toEqual([0, 1, 2]);
  });

  it('keeps waiting forever when the deadline is disabled', async () => {
    const state = { closed: false };
    let ticks = 0;
    const seen: number[] = [];
    for await (const chunk of withIdleWatchdog(scheduledStream([50], state), {
      idleMs: 0,
      tickMs: 10,
      onTick: () => ticks++,
    })) {
      seen.push(chunk);
    }
    expect(seen).toEqual([0]);
    expect(ticks).toBeGreaterThan(1);
  });

  it('propagates a stream error unchanged', async () => {
    const boom = new Error('upstream exploded');
    const source: AsyncIterable<number> = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw boom;
      },
    };

    let err: unknown;
    try {
      for await (const _chunk of withIdleWatchdog(source, { idleMs: 1000, tickMs: 10 })) {
        // unreachable
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBe(boom);
  });

  it('closes the stream when the consumer breaks out early', async () => {
    const state = { closed: false };
    for await (const _chunk of withIdleWatchdog(scheduledStream([1, 1, 1], state), { idleMs: 200, tickMs: 5 })) {
      break;
    }
    await sleep(5);
    expect(state.closed).toBe(true);
  });
});

describe('anySignal', () => {
  it('fires when the turn is aborted', () => {
    const turn = new AbortController();
    const idle = new AbortController();
    const combined = anySignal(turn.signal, idle.signal);
    expect(combined.aborted).toBe(false);
    turn.abort();
    expect(combined.aborted).toBe(true);
  });

  it('fires when only the request is aborted, leaving the turn alive', () => {
    const turn = new AbortController();
    const idle = new AbortController();
    const combined = anySignal(turn.signal, idle.signal);
    idle.abort();
    expect(combined.aborted).toBe(true);
    expect(turn.signal.aborted).toBe(false);
  });

  it('is already aborted when a source was', () => {
    const turn = new AbortController();
    turn.abort();
    expect(anySignal(turn.signal, new AbortController().signal).aborted).toBe(true);
  });
});
