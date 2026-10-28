import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientCall = vi.hoisted(() => vi.fn());

vi.mock('../../../../memory/client.js', () => ({
  MemoryUnavailable: class MemoryUnavailable extends Error {},
  retryRead: (work: (client: { call: typeof clientCall }) => Promise<unknown>) => work({ call: clientCall }),
  withMemory: (work: (client: { call: typeof clientCall }) => Promise<unknown>) => work({ call: clientCall }),
  withReceiptMemory: (_key: string, work: (client: { call: typeof clientCall }) => Promise<unknown>) =>
    work({ call: clientCall }),
}));

import { createMemoryMcpServer } from './memory.js';

const server = createMemoryMcpServer();
const context = (
  server as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
  }
)._registeredTools.context!.handler;

beforeEach(() => clientCall.mockReset());

describe('memory context dispatch', () => {
  it('uses recall for a focused question and preserves every absence status', async () => {
    for (const status of ['empty', 'degraded', 'unavailable']) {
      clientCall.mockResolvedValueOnce({
        status,
        results: [],
        searched: ['Compare Zephyr QX-100 and Aster QX-200'],
        budget_used: 0,
      });
      const reply = await context({ query: 'Compare Zephyr QX-100 and Aster QX-200' });
      expect(clientCall).toHaveBeenLastCalledWith('recall', {
        query: 'Compare Zephyr QX-100 and Aster QX-200',
        budget: 20_000,
      });
      expect(JSON.parse(reply.content[0]!.text).status).toBe(status);
    }
  });

  it('keeps the ambient sections available for an explicit broad briefing', async () => {
    clientCall.mockResolvedValueOnce({
      status: 'ok',
      results: [],
      timeline: [{ summary: 'unrelated household event' }],
      structure: 'household/',
      budget_used: 12,
    });
    const reply = await context({ query: 'Household briefing', profile: 'default' });
    expect(clientCall).toHaveBeenCalledWith('context', { query: 'Household briefing', profile: 'default' });
    expect(JSON.parse(reply.content[0]!.text).timeline).toHaveLength(1);
  });
});
