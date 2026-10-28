import http from 'node:http';
import { connect, PROTOCOL_VERSION, type AknoClient } from '@tenphi/akno-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';

let client: AknoClient;
vi.mock('../../../../memory/client.js', () => ({
  MemoryUnavailable: class MemoryUnavailable extends Error {},
  retryRead: (work: (client: AknoClient) => Promise<unknown>) => work(client),
  withMemory: (work: (client: AknoClient) => Promise<unknown>) => work(client),
  withReceiptMemory: (_key: string, work: (client: AknoClient) => Promise<unknown>) => work(client),
}));
vi.mock('../../../../modules/memory-namespace/index.js', () => ({
  assertExistingRoot: vi.fn(),
  declareNamespace: vi.fn(),
}));
vi.mock('../../../../memory/digest.js', () => ({ noteAgentMemoryPages: vi.fn() }));

import { createMemoryMcpServer } from './memory.js';
import { dispatch } from '../../../../cli/dispatch.js';
import '../../../../cli/resources/memory-proposals.js';

const registered = (
  createMemoryMcpServer() as unknown as {
    _registeredTools: Record<
      string,
      {
        inputSchema: z.ZodObject;
        handler: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
      }
    >;
  }
)._registeredTools;
const calls: { op: string; input: Record<string, unknown> }[] = [];
let result: unknown;
let features: string[];
let service: http.Server;
let address: string;

async function invoke(name: string, input: unknown) {
  const tool = registered[name]!;
  return tool.handler(tool.inputSchema.parse(input));
}

beforeEach(async () => {
  calls.length = 0;
  features = ['folder_timelines'];
  result = { status: 'empty', results: [], total: 0 };
  service = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/hello') {
      response.end(
        JSON.stringify({
          hello: 'akno',
          protocol: PROTOCOL_VERSION,
          version: '0.14.0',
          writable: true,
          akno_path: '/invented/memory',
          ops: ['list', 'timeline', 'context', 'recall', 'write', 'remember'],
          features,
        }),
      );
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ op: request.url!.replace('/op/', ''), input: JSON.parse(body) });
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  client = await connect({ http: address });
});

afterEach(async () => {
  await client.close();
  service.closeAllConnections();
  await new Promise<void>((resolve) => service.close(() => resolve()));
});

describe('released timeline contract through Luna', () => {
  it('discovers empty and unwritable declarations without inventing a destination', async () => {
    result = {
      status: 'degraded',
      total: 2,
      timelines: [
        {
          slug: 'work/timeline',
          path: 'work/timeline.md',
          folder: 'work',
          default: false,
          title: 'Work',
          description: 'Project events',
          status: 'ready',
          writable: true,
        },
        {
          slug: 'case/timeline',
          path: 'case/timeline.md',
          folder: 'case',
          default: false,
          title: 'Case',
          description: '',
          status: 'invalid',
          writable: false,
          note: 'Invalid declaration',
        },
      ],
    };
    expect(JSON.parse((await invoke('list', { kind: 'timelines' })).content[0]!.text)).toEqual(result);
    expect(calls).toEqual([{ op: 'list', input: { kind: 'timelines' } }]);
  });

  it.each(['work/timeline', '*', undefined])(
    'preserves selection %s, real filters and qualified membership',
    async (timeline) => {
      const input = {
        ...(timeline ? { timeline } : {}),
        since: '2031-04',
        until: '2031-05',
        match: 'prototype',
        subject: 'work/prototype',
        source: 'plan',
        temporal_status: 'tentative',
        clock_relation: 'future',
        disposition: 'proposed',
        view: 'history',
        limit: 20,
      };
      result = {
        status: 'ok',
        selected_timelines: ['work/timeline'],
        results: [
          {
            type: 'memory',
            source_kind: 'plan',
            temporal_status: 'tentative',
            disposition: 'proposed',
            timeline: 'work/timeline',
            timeline_basis: 'source_page',
          },
        ],
      };
      expect(JSON.parse((await invoke('timeline', input)).content[0]!.text)).toEqual(result);
      expect(calls).toEqual([{ op: 'timeline', input }]);
    },
  );

  it('makes focused history explicit without adding unrelated pins or structure', async () => {
    await invoke('context', { query: 'Prototype milestones', timeline: 'work/timeline' });
    expect(calls[0]).toEqual({
      op: 'context',
      input: {
        query: 'Prototype milestones',
        timeline: 'work/timeline',
        profile: 'default',
        pinned: [],
        timeline_days: 90,
        structure: false,
      },
    });
    await invoke('context', { query: 'Prototype milestones', timeline: 'work/timeline', timeline_days: 7 });
    expect(calls[1]!.input.timeline_days).toBe(7);
    await invoke('context', { query: 'Prototype milestones', timeline: 'work/timeline', timeline_days: 0 });
    expect(calls[2]!.input.timeline_days).toBe(0);
    await invoke('context', { query: 'Prototype milestones' });
    expect(calls[3]).toEqual({ op: 'recall', input: { query: 'Prototype milestones', budget: 20000 } });
    await invoke('context', { query: 'Prototype milestones', profile: 'auto_recall' });
    expect(calls[4]).toEqual({ op: 'context', input: { query: 'Prototype milestones', profile: 'auto_recall' } });
  });

  it('preserves event receipts, holds, and mixed remember change ordering', async () => {
    const event = { date: '2031-04-01', summary: 'Prototype arrived.' };
    const receipt = {
      status: 'ok',
      outcome: 'ok',
      change_id: 'chg_event',
      wrote: [{ slug: 'work/timeline', action: 'event', timeline: 'work/timeline', timeline_basis: 'ledger' }],
    };
    result = receipt;
    expect(
      JSON.parse(
        (await invoke('write', { event, timeline: 'work/timeline', idempotency_key: 'invented:event' })).content[0]!
          .text,
      ),
    ).toEqual(receipt);
    expect(calls[0]!.input).toEqual({ event, timeline: 'work/timeline', idempotency_key: 'invented:event' });
    result = {
      status: 'ok',
      outcome: 'requires_approval',
      hold: { reason: 'timeline_required', timelines: ['timeline', 'work/timeline'] },
    };
    expect(JSON.parse((await invoke('write', { event })).content[0]!.text)).toEqual(result);
    expect(calls).toHaveLength(2); // No fallback write into the root.
    result = {
      status: 'degraded',
      outcome: 'ok',
      change_ids: ['chg_page', 'chg_work', 'chg_root'],
      wrote: receipt.wrote,
      held_events: [{ reason: 'routing_uncertain' }],
    };
    expect(JSON.parse((await invoke('remember', { text: 'A mixed invented conversation.' })).content[0]!.text)).toEqual(
      result,
    );
  });

  it('exposes the same discovery and selection through the host CLI', async () => {
    result = { status: 'ok', timelines: [], total: 0 };
    const listed = await dispatch({ id: 'list', command: 'memory-timelines', args: {} }, { caller: 'host' });
    expect(listed).toMatchObject({ ok: true, data: result });
    result = { status: 'degraded', selected_timelines: ['work/timeline'], results: [], total: 0 };
    const read = await dispatch(
      {
        id: 'read',
        command: 'memory-timeline',
        args: {
          timeline: 'work/timeline',
          since: '2031-04',
          limit: '12',
          'clock-relation': 'overdue',
          'as-of': '2031-04-01T12:00:00Z',
        },
      },
      { caller: 'host' },
    );
    expect(read).toMatchObject({ ok: true, data: result });
    expect(calls).toEqual([
      { op: 'list', input: { kind: 'timelines' } },
      {
        op: 'timeline',
        input: {
          timeline: 'work/timeline',
          since: '2031-04',
          limit: 12,
          clock_relation: 'overdue',
          as_of: '2031-04-01T12:00:00Z',
        },
      },
    ]);
  });

  it('refuses selectors on an older service before any request or fallback reaches it', async () => {
    features = [];
    await client.close();
    client = await connect({ http: address });
    for (const [name, input] of [
      ['list', { kind: 'timelines' }],
      ['timeline', { timeline: 'work/timeline' }],
      ['context', { query: 'Prototype', timeline: 'work/timeline' }],
      ['write', { timeline: 'work/timeline', event: { date: '2031-04-01', summary: 'Prototype arrived.' } }],
    ] as const) {
      const reply = await invoke(name, input);
      expect(reply.isError).toBe(true);
      expect(reply.content[0]!.text).toContain('does not support folder-owned timelines');
    }
    const reply = await dispatch(
      { id: 'old', command: 'memory-timeline', args: { timeline: '*' } },
      { caller: 'host' },
    );
    expect(reply.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
