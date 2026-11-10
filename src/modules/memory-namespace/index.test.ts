import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  roots: [] as string[],
  calls: [] as Array<{ name: string; input: unknown }>,
  pending: [] as Array<{ approval_id: string; payload: string; status: string; created_at: string }>,
  requested: [] as unknown[],
  handler: null as
    null | ((ctx: { payload: Record<string, unknown>; notify: (text: string) => void }) => Promise<void>),
  caller: { agentGroupId: 'group-1', sessionId: 'session-1' },
}));

vi.mock('../../memory/client.js', () => ({
  withMemory: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      call: async (name: string, input: unknown) => {
        state.calls.push({ name, input });
        if (name === 'list') return { folders: state.roots.map((path) => ({ path })) };
        if (name === 'folder') {
          if (!(input as { dry_run?: boolean }).dry_run) state.roots.push((input as { path: string }).path);
          return { status: 'ok', outcome: 'ok' };
        }
        throw new Error(`unexpected ${name}`);
      },
    }),
}));
vi.mock('../../host-mcp/caller-context.js', () => ({ currentCaller: () => state.caller }));
vi.mock('../../db/sessions.js', () => ({
  getSession: () => ({ id: 'session-1', agent_group_id: 'group-1' }),
  getPendingApprovalsByAction: () => state.pending,
  deletePendingApproval: (id: string) => {
    state.pending = state.pending.filter((row) => row.approval_id !== id);
  },
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: () => ({ name: 'Luna' }) }));
vi.mock('../approvals/index.js', () => ({
  requestApproval: async (input: unknown) => {
    state.requested.push(input);
  },
  registerApprovalHandler: (
    _action: string,
    handler: (ctx: { payload: Record<string, unknown>; notify: (text: string) => void }) => Promise<void>,
  ) => {
    state.handler = handler;
  },
}));

import { assertExistingRoot, declareNamespace, rootOf } from './index.js';
import './register.js';

beforeEach(() => {
  state.roots = ['research'];
  state.calls = [];
  state.pending = [];
  state.requested = [];
});

describe('top-level memory namespace approval', () => {
  it('allows a subfolder of an existing root and blocks alternate writes into a missing root', async () => {
    expect(rootOf('research/papers')).toBe('research');
    await assertExistingRoot(
      { call: async () => ({ folders: [{ path: 'research' }] }) } as never,
      'research/papers/page',
    );
    await expect(
      assertExistingRoot({ call: async () => ({ folders: [{ path: 'research' }] }) } as never, 'private/page'),
    ).rejects.toThrow('owner approval');
    expect(await declareNamespace({ path: 'research/papers', description: 'Research papers.' })).toMatchObject({
      outcome: 'ok',
    });
    expect(state.requested).toHaveLength(0);
  });

  it('queues one exact policy and does not declare it before approval', async () => {
    const declaration = {
      path: 'archives',
      description: 'Saved source records.',
      role: 'source' as const,
      remember: 'deny' as const,
    };
    expect(await declareNamespace({ ...declaration, idempotency_key: 'first-attempt' })).toMatchObject({
      outcome: 'approval_pending',
    });
    expect(state.roots).not.toContain('archives');
    expect(state.requested).toHaveLength(1);
    const request = state.requested[0] as { payload: { declaration: typeof declaration; issuedAt: number } };
    expect(request.payload.declaration).toEqual(declaration);
    state.pending.push({
      approval_id: 'appr-1',
      payload: JSON.stringify(request.payload),
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    expect(await declareNamespace({ ...declaration, idempotency_key: 'second-attempt' })).toMatchObject({
      outcome: 'approval_pending',
      approval_id: 'appr-1',
    });
    expect(state.requested).toHaveLength(1);
    await expect(declareNamespace({ ...declaration, role: 'knowledge' })).rejects.toThrow('different policy');

    const notifications: string[] = [];
    await state.handler!({ payload: request.payload, notify: (text: string) => notifications.push(text) });
    expect(state.roots).toContain('archives');
    expect(
      state.calls.filter((call) => call.name === 'folder' && !(call.input as { dry_run?: boolean }).dry_run),
    ).toHaveLength(1);
    expect(notifications[0]).toContain('retry the original memory write');
  });

  it('rejects expired approval without creating a namespace', async () => {
    await expect(
      state.handler!({
        payload: { declaration: { path: 'old', description: 'Old.' }, issuedAt: Date.now() - 25 * 60 * 60 * 1000 },
        notify: () => {},
      }),
    ).rejects.toThrow('expired');
    expect(state.roots).not.toContain('old');
  });
});
