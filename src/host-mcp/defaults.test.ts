import { describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({
  buildHostMcpRegistry: () => ({
    port: 18800,
    providers: {
      apple_calendar: {
        name: 'apple_calendar',
        kind: 'builtin',
        requiresExplicitHost: false,
        oneCli: false,
      },
      vulpine: {
        name: 'vulpine',
        kind: 'stdio',
        requiresExplicitHost: true,
        oneCli: true,
      },
    },
  }),
}));

vi.mock('../db/install-settings.js', () => ({
  getMcpToolFilters: () => ({}),
}));

vi.mock('./tokens.js', () => ({
  readOrCreatePairToken: () => 'token-123',
}));

vi.mock('./builtins/email/shared/config.js', () => ({
  loadEmailConfig: () => ({ toolsAllow: ['list_envelopes'] }),
}));

import { appendHostMcpNoProxyToContainerArgs, mergeHostMcpRelays } from './defaults.js';

describe('mergeHostMcpRelays', () => {
  it('injects relay for default builtin provider and explicit host stdio provider', () => {
    const out = mergeHostMcpRelays(
      {
        vulpine: { host: true, toolsAllow: ['summary'] },
      },
      'group-1',
    );
    expect(out.apple_calendar?.command).toBe('bun');
    expect(out.apple_calendar?.env?.MCP_RELAY_URL).toContain('/mcp/group-1/apple_calendar');
    expect(out.vulpine?.host).toBeUndefined();
    expect(out.vulpine?.env?.MCP_RELAY_TOKEN).toBe('token-123');
    expect(out.vulpine?.toolsAllow).toEqual(['summary']);
    expect(out.apple_mail).toBeUndefined();
  });

  it('skips stdio providers unless marked host in group config', () => {
    const out = mergeHostMcpRelays({}, 'group-1');
    expect(out.vulpine).toBeUndefined();
  });

  it('respects MCP_DISABLE opt-out', () => {
    const out = mergeHostMcpRelays(
      {
        apple_calendar: { env: { MCP_DISABLE: 'true' } },
      },
      'group-1',
    );
    expect(out.apple_calendar?.command).toBeUndefined();
  });
});

describe('appendHostMcpNoProxyToContainerArgs', () => {
  it('adds NO_PROXY and no_proxy values', () => {
    const args = ['run', '--rm'];
    appendHostMcpNoProxyToContainerArgs(args);
    expect(args.join(' ')).toContain('NO_PROXY=');
    expect(args.join(' ')).toContain('no_proxy=');
    expect(args.join(' ')).toContain('host.docker.internal');
  });
});
