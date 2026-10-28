import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAgentGroup = vi.fn();
const mockGetTheAgent = vi.fn();
vi.mock('../../bootstrap.js', () => ({
  getTheAgent: () => mockGetTheAgent(),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

vi.mock('../../container-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../container-config.js')>();
  return {
    ...actual,
    readStoredContainerConfig: () => ({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      cliScope: 'agent',
    }),
  };
});

const mockExec = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExec(...args),
  };
});

import { dispatch } from '../dispatch.js';
import '../resources/index.js';
import './system-prompt-stats.js';

function agentCtx(overrides?: Partial<{ agentGroupId: string }>) {
  return {
    caller: 'agent' as const,
    sessionId: 's1',
    agentGroupId: 'ag-main',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

describe('system-prompt-stats command', () => {
  beforeEach(() => {
    mockGetAgentGroup.mockReset();
    mockGetTheAgent.mockReset();
    mockGetTheAgent.mockReturnValue({ id: 'luna-default', name: 'Luna' });
    mockExec.mockReset();
    mockExec.mockReturnValue('report');
  });

  it('runs measure script without folder arg for host caller', async () => {
    const res = await dispatch(
      { id: '1', command: 'system-prompt-stats', args: { session: true } },
      { caller: 'host' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toBe('report');
    expect(mockExec.mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.stringContaining('measure-system-prompt.ts'), '--session']),
    );
    expect(mockExec.mock.calls[0][1]).not.toContain('luna');
  });

  it('runs measure script for agent caller', async () => {
    mockGetAgentGroup.mockReturnValue({ id: 'ag-main', name: 'Luna' });
    const res = await dispatch({ id: '1', command: 'system-prompt-stats', args: { tokens: true } }, agentCtx());
    expect(res.ok).toBe(true);
    expect(mockExec.mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.stringContaining('measure-system-prompt.ts'), '--tokens']),
    );
  });
});
