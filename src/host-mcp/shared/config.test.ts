import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockPort = 18800;
const mockMcpServers: Record<
  string,
  {
    command?: string;
    cwd?: string;
    args?: string[];
    env?: Record<string, string>;
    oneCli?: boolean;
    host?: boolean;
  }
> = {};

vi.mock('../../config/loader.js', () => ({
  loadLunaConfig: () => ({ mcpPort: mockPort, mcpServers: mockMcpServers }),
  clearConfigCache: () => {},
}));

const written: unknown[] = [];
vi.mock('../../config/write.js', () => ({
  patchLocalConfig: (section: string, value: unknown) => {
    written.push({ section, value });
    if (section === 'mcpPort' && typeof value === 'number') mockPort = value;
    if (section === 'mcpServers' && typeof value === 'object' && value !== null) {
      for (const key of Object.keys(mockMcpServers)) delete mockMcpServers[key];
      Object.assign(mockMcpServers, value);
    }
  },
}));

import {
  DEFAULT_HOST_MCP_PORT,
  loadHostMcpInstallConfig,
  removeHostMcpServer,
  setHostMcpPort,
  setHostMcpServer,
} from './config.js';

describe('host MCP install config', () => {
  beforeEach(() => {
    mockPort = DEFAULT_HOST_MCP_PORT;
    for (const key of Object.keys(mockMcpServers)) delete mockMcpServers[key];
    written.length = 0;
  });

  afterEach(() => {
    mockPort = DEFAULT_HOST_MCP_PORT;
    for (const key of Object.keys(mockMcpServers)) delete mockMcpServers[key];
  });

  it('returns defaults when no servers configured', () => {
    const cfg = loadHostMcpInstallConfig();
    expect(cfg.port).toBe(DEFAULT_HOST_MCP_PORT);
    expect(cfg.servers).toEqual({});
  });

  it('loads valid config and defaults oneCli to true', () => {
    mockPort = 18901;
    mockMcpServers.vulpine = {
      host: true,
      command: 'node',
      args: ['bin/vulpine-mcp.js'],
      cwd: '/tmp/vulpine',
      env: { vulpine_ENVIRONMENT: 'sandbox' },
    };
    const cfg = loadHostMcpInstallConfig();
    expect(cfg.port).toBe(18901);
    expect(cfg.servers.vulpine?.oneCli).toBe(true);
    expect(cfg.servers.vulpine?.command).toBe('node');
  });

  it('ignores invalid server entries', () => {
    mockMcpServers.invalid1 = { host: true, command: '', cwd: '' };
    mockMcpServers.invalid2 = { host: true, command: 'node', cwd: '' };
    mockMcpServers.valid = { host: true, command: 'node', cwd: '/tmp/repo' };
    const cfg = loadHostMcpInstallConfig();
    expect(Object.keys(cfg.servers)).toEqual(['valid']);
  });

  it('set/remove server persists via local overlay', () => {
    setHostMcpServer('vulpine', { command: 'node', args: ['bin/vulpine-mcp.js'], cwd: '/tmp/vulpine' });
    let cfg = loadHostMcpInstallConfig();
    expect(cfg.servers.vulpine?.cwd).toBe('/tmp/vulpine');

    removeHostMcpServer('vulpine');
    cfg = loadHostMcpInstallConfig();
    expect(cfg.servers.vulpine).toBeUndefined();
    expect(written.length).toBeGreaterThan(0);
  });

  it('set port normalizes invalid values', () => {
    setHostMcpPort(70000);
    const cfg = loadHostMcpInstallConfig();
    expect(cfg.port).toBe(DEFAULT_HOST_MCP_PORT);
  });
});
