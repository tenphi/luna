/**
 * HttpSessionClient transport behaviour.
 *
 * The Session API is the container's only way to reach session state, so the
 * client's retry and timeout policy decides whether a host blip is a hiccup or
 * a dead agent. Exercised against a stubbed global fetch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { HttpSessionClient } from './client.js';

const URL_BASE = 'http://host.test/session/ag-1/sess-1';

const realFetch = globalThis.fetch;

function jsonOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let client: HttpSessionClient;

beforeEach(() => {
  client = new HttpSessionClient(URL_BASE, 'tok');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('HttpSessionClient.rpc', () => {
  it('stages memory originals over the authenticated host RPC', async () => {
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      expect(url).toBe(`${URL_BASE}/rpc`);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      expect(JSON.parse(init.body as string)).toEqual({
        method: 'stageMemoryFile', params: { document: 'doc-example', id: 'out-1', filename: 'scan.pdf' },
      });
      return jsonOk({ filename: 'scan.pdf' });
    }) as typeof fetch;
    expect(await client.stageMemoryFile('doc-example', 'out-1', 'scan.pdf')).toEqual({ filename: 'scan.pdf' });
  });

  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return jsonOk([]);
    }) as typeof fetch;

    await expect(client.getPendingMessages(true)).resolves.toEqual([]);
    expect(calls).toBe(3);
  });

  it('retries a 500 — a handler error can be a transient SQLITE_BUSY', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) return new Response('{"ok":false,"error":"busy"}', { status: 500 });
      return jsonOk({ value: 'v' });
    }) as typeof fetch;

    await expect(client.getSessionState('k')).resolves.toBe('v');
    expect(calls).toBe(2);
  });

  it('fails fast on 401 instead of burning the retry budget', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"ok":false,"error":"Unauthorized"}', { status: 401 });
    }) as typeof fetch;

    await expect(client.getPendingMessages(true)).rejects.toThrow('HTTP 401');
    // A rejected token never becomes valid by asking again.
    expect(calls).toBe(1);
  });

  it('gives up after exhausting retries rather than hanging', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    await expect(client.getPendingMessages(true)).rejects.toThrow('ECONNREFUSED');
    expect(calls).toBe(5); // initial attempt + MAX_RETRIES
  });

  it('sends an abort signal so a hung host cannot park the caller forever', async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seenSignal = init.signal ?? undefined;
      return jsonOk([]);
    }) as unknown as typeof fetch;

    await client.getPendingMessages(true);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});
