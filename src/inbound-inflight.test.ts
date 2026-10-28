import { describe, it, expect } from 'vitest';

import { drainInboundRouting, inFlightInboundCount, trackInboundRouting } from './inbound-inflight.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('inbound in-flight tracking', () => {
  it('holds shutdown until a route finishes', async () => {
    const route = deferred();
    trackInboundRouting(route.promise);
    expect(inFlightInboundCount()).toBe(1);

    let drained = false;
    const drain = drainInboundRouting(1000).then((stranded) => {
      drained = true;
      return stranded;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);

    route.resolve();
    await expect(drain).resolves.toBe(0);
  });

  it('reports routes it gave up on rather than waiting forever', async () => {
    const stuck = deferred();
    trackInboundRouting(stuck.promise);

    await expect(drainInboundRouting(20)).resolves.toBe(1);

    stuck.resolve();
    await drainInboundRouting(100);
  });

  it('stops tracking a route that failed — a rejection is still a finished route', async () => {
    const failing = deferred();
    trackInboundRouting(failing.promise.catch(() => {}));

    failing.reject(new Error('routing blew up'));

    await expect(drainInboundRouting(1000)).resolves.toBe(0);
    expect(inFlightInboundCount()).toBe(0);
  });

  it('returns immediately when nothing is in flight', async () => {
    expect(inFlightInboundCount()).toBe(0);
    await expect(drainInboundRouting(60_000)).resolves.toBe(0);
  });
});
