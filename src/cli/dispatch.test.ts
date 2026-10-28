import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockReadStoredContainerConfig = vi.fn();
vi.mock('../container-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../container-config.js')>();
  return {
    ...actual,
    readStoredContainerConfig: (...args: unknown[]) => mockReadStoredContainerConfig(...args),
  };
});

const mockGetAgentGroup = vi.fn();
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

// dispatch's post-handler looks up the resource's `scopeField` via getResource.
// The real resources aren't registered in this unit test, so mock it.
const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));

// Register a test command so dispatch has something to find
import { register } from './registry.js';

register({
  name: 'test-cmd',
  description: 'test command (non-group resource)',
  resource: 'test',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'config',
  description: 'test config command (allowed in agent scope)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'config-agent',
  description: 'test config-agent command (allowed in agent scope)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'config-agent-help',
  description: 'test config-agent-help (allowed in agent scope)',
  access: 'hidden',
  parseArgs: () => ({}),
  handler: async () => 'agent help',
});

register({
  name: 'config-help',
  description: 'test config-help (allowed in agent scope)',
  access: 'hidden',
  parseArgs: () => ({}),
  handler: async () => 'config help',
});

register({
  name: 'config-agent-set',
  description: 'test config-agent-set command (allowed in agent scope)',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'general-cmd',
  description: 'test command (no resource, like help)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

const mockValidateArgs = vi.fn();
register({
  name: 'config-agent-add-package',
  description: 'test approval command with a pre-approval validator',
  access: 'approval',
  validateArgs: (raw) => mockValidateArgs(raw),
  approvalCard: (raw) => ({ title: `Install package: ${raw.apt}`, question: `resulting apt list: ${raw.apt}` }),
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'sessions-list',
  description: 'test command (sessions resource)',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'destinations-list',
  description: 'test command (destinations resource)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'members-add',
  description: 'test command (members resource)',
  resource: 'members',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'test command (wirings resource — not allowed)',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

// Commands that return data shaped like real resources (for post-handler filtering tests)
register({
  name: 'sessions-list-data',
  description: 'returns mock session rows',
  resource: 'sessions',
  access: 'open',
  generic: 'list',
  parseArgs: (raw) => raw,
  handler: async () => [
    { id: 's1', agent_group_id: 'g1' },
    { id: 's2', agent_group_id: 'g2' },
  ],
});

register({
  name: 'sessions-get-data',
  description: 'returns a mock session row',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({
    id: args.id,
    agent_group_id: (args as Record<string, unknown>).belongs_to ?? 'g1',
  }),
});

// The real `sessions-get` name — triggers the pre-handler ownership check.
register({
  name: 'sessions-get',
  description: 'generic sessions get',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ id: (args as Record<string, unknown>).id, agent_group_id: 'g1' }),
});

register({
  name: 'destinations-get-by-id-test',
  description: 'get destination by id (dispatch resolution test)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ id: (args as Record<string, unknown>).id }),
});

import { requestApproval } from '../modules/approvals/index.js';
import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentGroup.mockReturnValue({
    id: 'g1',
    name: 'Test',
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  mockReadStoredContainerConfig.mockReturnValue({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    cliScope: 'agent',
  });
  // Default: the four CLI-whitelisted resources with their real scopeFields.
  const scopeFields: Record<string, string> = {
    sessions: 'agent_group_id',
    destinations: 'agent_group_id',
    members: 'agent_group_id',
  };
  mockGetResource.mockImplementation((plural: string) =>
    scopeFields[plural] ? { scopeField: scopeFields[plural] } : undefined,
  );
});

// --- Helpers ---

function agentCtx(overrides?: Partial<Extract<CallerContext, { caller: 'agent' }>>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 's1',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

// --- Tests ---

describe('pre-approval arg validation', () => {
  beforeEach(() => {
    mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'g1' });
    mockGetAgentGroup.mockReturnValue({ id: 'g1', name: 'Luna' });
    mockValidateArgs.mockReset();
  });

  // The whole point of the hook: parseArgs runs *after* the approval branch
  // returns, so validation there would only reject once the owner had tapped.
  it('rejects invalid args without ever creating an approval card', async () => {
    mockValidateArgs.mockImplementation(() => {
      throw new Error('Invalid apt package spec "foo && id".');
    });

    const resp = await dispatch(
      { id: '1', command: 'config-agent-add-package', args: { apt: 'foo && id' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('invalid-args');
      expect(resp.error.message).toContain('Invalid apt package spec');
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('still gates a valid approval command behind an approval card', async () => {
    const resp = await dispatch(
      { id: '1', command: 'config-agent-add-package', args: { apt: 'imagemagick' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('uses the command-supplied approval card when present', async () => {
    await dispatch({ id: '1', command: 'config-agent-add-package', args: { apt: 'imagemagick' } }, agentCtx());

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Install package: imagemagick',
        question: 'resulting apt list: imagemagick',
      }),
    );
  });

  it('quotes arg values in the generic card so metacharacters read as data', async () => {
    await dispatch({ id: '1', command: 'config-agent-set', args: { model: 'a b' } }, agentCtx());

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ question: expect.stringContaining("--model 'a b'") }),
    );
  });

  it('validates host callers too', async () => {
    mockValidateArgs.mockImplementation(() => {
      throw new Error('Invalid apt package spec "foo;id".');
    });

    const resp = await dispatch(
      { id: '1', command: 'config-agent-add-package', args: { apt: 'foo;id' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('invalid-args');
  });
});

describe('CLI scope enforcement', () => {
  it('disabled: rejects all CLI requests from agent', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'disabled' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('disabled');
    }
  });

  it('agent: allows config command', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'config', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('agent: allows config-agent and config-agent-help', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const show = await dispatch({ id: '1', command: 'config-agent', args: {} }, agentCtx());
    expect(show.ok).toBe(true);

    const help = await dispatch({ id: '2', command: 'config-agent-help', args: {} }, agentCtx());
    expect(help.ok).toBe(true);
  });

  it('agent: allows config-help (no resource field)', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'config-help', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('agent: blocks cli_scope escalation via config-agent-set', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'config-agent-set', args: { cli_scope: 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('cli_scope');
    }
  });

  it('agent: blocks cli-scope escalation (hyphenated)', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'config-agent-set', args: { 'cli-scope': 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('agent: blocks non-group resources', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('test');
    }
  });

  it('agent: allows whitelisted commands with no resource (e.g. config)', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'config', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('agent: allows sessions, auto-fills --agent_group_id', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'sessions-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.agent_group_id).toBe('g1');
      // --id should NOT be auto-filled for sessions (it's session UUID, not group)
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('agent: allows destinations, auto-fills --id', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'destinations-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('agent: cannot admit a user — the members resource is gone', async () => {
    // This asserted the opposite: that an agent-scoped agent could run `members-add` with its own
    // group auto-filled. Admission is the roster in config/local.jsonc now, so there is no command
    // for an agent to reach — which is the property worth pinning, since `cliScope: 'global'` (what
    // the install agent actually runs at) skips the whitelist entirely.
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'members-add', args: { user: 'u1' } }, agentCtx());

    expect(resp.ok).toBe(false);
    // `members-add` is registered by this file's own harness, so what is being asserted is the
    // whitelist: the resource is no longer on it.
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });

  it('agent: blocks non-whitelisted resources (wirings)', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('wirings');
    }
  });

  it('agent: rejects cross-group --agent_group_id', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-list', args: { agent_group_id: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('agent: rejects cross-group --group', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    // Deliberately a *whitelisted* resource: pointing this at `members` would now be refused by the
    // whitelist first and would stop testing cross-group scoping at all.
    const resp = await dispatch({ id: '1', command: 'sessions-list', args: { group: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('global: allows cross-group access', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: allows non-group resources', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: does not auto-fill --id', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('defaults to group when cli_scope is missing', async () => {
    mockReadStoredContainerConfig.mockReturnValue({});

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('host caller bypasses CLI scope enforcement', async () => {
    // No config check should happen for host callers
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'any-group' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(mockReadStoredContainerConfig).not.toHaveBeenCalled();
  });

  // --- Post-handler filtering ---

  it('agent: sessions list filters out other groups', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch({ id: '1', command: 'sessions-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string; agent_group_id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].agent_group_id).toBe('g1');
    }
  });

  it('agent: sessions get rejects cross-group session', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('different agent');
    }
  });

  it('agent: sessions get allows own-group session', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'g1' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
  });

  it('global: no post-handler filtering', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'global' });

    const resp = await dispatch({ id: '1', command: 'sessions-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(2);
    }
  });

  // --- sessions-get pre-handler ownership check (no existence oracle) ---

  it('agent: sessions-get returns "session not found" for a foreign session UUID', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });
    mockGetSession.mockReturnValue({ id: 's-x', agent_group_id: 'other-group' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-x' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('agent: sessions-get returns "session not found" for a non-existent UUID', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });
    mockGetSession.mockReturnValue(undefined);

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-nope' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('agent: sessions-get allows the caller’s own session', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });
    mockGetSession.mockReturnValue({ id: 's-mine', agent_group_id: 'g1' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-mine' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  // --- Fail-closed regression guard for a missing scopeField ---

  it('agent: generic list/get fails closed when the resource declares no scopeField', async () => {
    mockReadStoredContainerConfig.mockReturnValue({ cliScope: 'agent' });
    mockGetResource.mockReturnValue(undefined); // a whitelisted resource that forgot scopeField

    const resp = await dispatch({ id: '1', command: 'sessions-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('not available in agent scope');
    }
  });

  // --- Command resolution from joined positional argv ---

  it('resolves destinations-get with a dashed target id', async () => {
    const resp = await dispatch(
      { id: '1', command: 'destinations-get-by-id-test-abc-123', args: {} },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { id: string }).id).toBe('abc-123');
    }
  });
});
