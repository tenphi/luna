import { describe, expect, it, vi, beforeEach } from 'vitest';

const reply = vi.hoisted(() => ({
  result: { status: 'ok', outcome: 'noop', considered: [], note: 'nothing was kept' } as Record<string, unknown>,
}));

vi.mock('../../../../memory/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../memory/client.js')>('../../../../memory/client.js');
  return {
    ...actual,
    withMemory: async (work: (client: unknown) => Promise<unknown>) =>
      work({ call: async () => reply.result } as never),
  };
});

vi.mock('../../../../memory/digest.js', () => ({ noteAgentMemoryPages: vi.fn() }));
vi.mock('../../../../memory/change-notifications.js', () => ({ queueCallerMemoryChanges: vi.fn() }));

import { createMemoryMcpServer } from './memory.js';
import { queueCallerMemoryChanges } from '../../../../memory/change-notifications.js';

async function rememberResult(dryRun = false): Promise<Record<string, unknown>> {
  const server = createMemoryMcpServer();
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    }
  )._registeredTools;
  const result = await tools.remember!.handler({
    text: 'Please remember my parcel reference PCL-472.',
    dry_run: dryRun,
  });
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('remember receipts', () => {
  beforeEach(() => vi.clearAllMocks());
  it('offers a direct write after a successful no-op without claiming anything was saved', async () => {
    reply.result = { status: 'ok', outcome: 'noop', considered: [], note: 'nothing was kept' };
    const result = await rememberResult();
    expect(result.status).toBe('ok');
    expect(result.outcome).toBe('noop');
    expect(result.note).toMatch(/confirms no save.*memory_write.*declarative sentence/is);
  });

  it('leaves a confirmed write result intact', async () => {
    reply.result = { status: 'ok', outcome: 'ok', change_id: 'chg_fixture', wrote: [{ slug: 'household/parcels' }] };
    const result = await rememberResult();
    expect(result).toEqual(reply.result);
    expect(queueCallerMemoryChanges).toHaveBeenCalledWith(reply.result);
  });

  it('does not queue a preview as a committed change', async () => {
    reply.result = { status: 'ok', outcome: 'ok', wrote: [{ slug: 'household/parcels' }] };
    await rememberResult(true);
    expect(queueCallerMemoryChanges).not.toHaveBeenCalled();
  });
});
