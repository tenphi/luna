import { describe, expect, it } from 'bun:test';

import { clearCurrentInReplyTo, setCurrentInReplyTo } from '../../../current-batch.js';
import { McpBridge, flattenResult, memoryMutationArgs, memoryTransportFailure } from './mcp-bridge.js';

describe('memoryMutationArgs', () => {
  it('uses a stable replay key for one exact write regardless of argument order', () => {
    const first = memoryMutationArgs('memory', 'write', { slug: 'fictional/page', content: 'Invented fact' }, 'turn-1');
    const replay = memoryMutationArgs(
      'memory',
      'write',
      { content: 'Invented fact', slug: 'fictional/page' },
      'turn-1',
    );
    expect(first.idempotency_key).toBe(replay.idempotency_key);
    expect(
      memoryMutationArgs('memory', 'write', { slug: 'fictional/page', content: 'Other fact' }, 'turn-1')
        .idempotency_key,
    ).not.toBe(first.idempotency_key);
    expect(
      memoryMutationArgs('memory', 'write', { slug: 'fictional/page', content: 'Invented fact' }, 'turn-2')
        .idempotency_key,
    ).not.toBe(first.idempotency_key);
  });

  it('leaves read operations and other servers without a replay key', () => {
    expect(memoryMutationArgs('memory', 'read', { slug: 'fictional/page' }, 'turn-1')).not.toHaveProperty(
      'idempotency_key',
    );
    expect(memoryMutationArgs('email', 'send_mail', { to: 'friend@example.test' }, 'turn-1')).not.toHaveProperty(
      'idempotency_key',
    );
  });
});

describe('memoryTransportFailure', () => {
  it('distinguishes cancellation and deadline loss from a backend error response', () => {
    expect(memoryTransportFailure('write', new DOMException('cancelled', 'AbortError'))).toContain(
      'cancelled; commit outcome unknown',
    );
    expect(memoryTransportFailure('write', new Error('request timed out'))).toContain(
      'deadline exceeded; commit outcome unknown',
    );
    expect(flattenResult({ isError: true, content: [{ type: 'text', text: 'validation failed' }] }, 'write')).toBe(
      'MCP tool error (write): validation failed',
    );
  });
});

describe('receipt reconciliation across the relay', () => {
  it('replays a lost reply once with identical arguments and the remaining deadline', async () => {
    setCurrentInReplyTo('invented-turn');
    try {
      const bridge = new McpBridge();
      const calls: Array<{ args: Record<string, unknown>; timeout: number }> = [];
      const marker = {
        isError: true,
        content: [{ type: 'text', text: 'LUNA_RELAY_TRANSPORT_UNCERTAIN:connection lost: socket closed' }],
      };
      const receipt = { content: [{ type: 'text', text: '{"status":"ok","replayed":true}' }] };
      const initial = {
        callTool: async (
          request: { arguments: Record<string, unknown> },
          _schema: unknown,
          options: { timeout: number },
        ) => {
          calls.push({ args: request.arguments, timeout: options.timeout });
          return marker;
        },
      };
      const reopened = {
        callTool: async (
          request: { arguments: Record<string, unknown> },
          _schema: unknown,
          options: { timeout: number },
        ) => {
          calls.push({ args: request.arguments, timeout: options.timeout });
          return receipt;
        },
      };
      const internals = bridge as unknown as {
        clients: Map<string, typeof initial>;
        toolIndex: Map<string, { server: string; toolName: string }>;
        reopenServer: () => Promise<typeof reopened>;
      };
      internals.clients.set('memory', initial);
      internals.toolIndex.set('memory_write', { server: 'memory', toolName: 'write' });
      internals.reopenServer = async () => reopened;

      expect(await bridge.call('memory_write', { slug: 'fictional/page', content: 'Invented fact.' })).toBe(
        '{"status":"ok","replayed":true}',
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args).toEqual(calls[1]!.args);
      expect(calls[0]!.args.idempotency_key).toMatch(/^luna:/);
      expect(calls[1]!.timeout).toBeLessThan(300_000);
    } finally {
      clearCurrentInReplyTo();
    }
  });

  it('does not replay a backend refusal', async () => {
    setCurrentInReplyTo('invented-turn');
    try {
      const bridge = new McpBridge();
      let calls = 0;
      const internals = bridge as unknown as {
        clients: Map<string, { callTool: () => Promise<unknown> }>;
        toolIndex: Map<string, { server: string; toolName: string }>;
        reopenServer: () => Promise<never>;
      };
      internals.clients.set('memory', {
        callTool: async () => {
          calls += 1;
          return { isError: true, content: [{ type: 'text', text: 'validation failed' }] };
        },
      });
      internals.toolIndex.set('memory_write', { server: 'memory', toolName: 'write' });
      internals.reopenServer = async () => {
        throw new Error('unexpected reconnect');
      };

      expect(await bridge.call('memory_write', { slug: 'fictional/page', content: 'Invented fact.' })).toBe(
        'MCP tool error (memory_write): validation failed',
      );
      expect(calls).toBe(1);
    } finally {
      clearCurrentInReplyTo();
    }
  });
});

describe('flattenResult', () => {
  it('returns raw text for successful tool results', () => {
    expect(flattenResult({ content: [{ type: 'text', text: '{"slug":"users/shared"}' }] }, 'get_memory_page')).toBe(
      '{"slug":"users/shared"}',
    );
  });

  it('prefixes isError results with MCP tool error and keeps the body', () => {
    const body = JSON.stringify({ error: 'internal_error', message: 'embedding dim mismatch' }, null, 2);
    expect(
      flattenResult(
        {
          isError: true,
          content: [{ type: 'text', text: body }],
        },
        'put_memory_page',
      ),
    ).toBe(`MCP tool error (put_memory_page): ${body}`);
  });

  it('marks empty isError content as a failure', () => {
    expect(
      flattenResult(
        {
          isError: true,
          content: [],
        },
        'search_memory',
      ),
    ).toBe('MCP tool error (search_memory): (empty error result)');
  });

  it('prefixes isError when content is missing (JSON fallback)', () => {
    const result = { isError: true, foo: 'bar' };
    expect(flattenResult(result, 'put_memory_page')).toBe(
      `MCP tool error (put_memory_page): ${JSON.stringify(result)}`,
    );
  });
});
