import { describe, expect, test } from 'bun:test';

import { buildRuntimeMcpServers } from './build-mcp-servers.js';

describe('buildRuntimeMcpServers', () => {
  test('merges luna filters from config without overriding command', () => {
    const servers = buildRuntimeMcpServers(
      {
        luna: { toolsAllow: ['send_message'] },
        custom: { command: 'custom', args: ['serve'], env: {} },
      },
      { command: 'bun', args: ['run', '/mcp'], env: {} },
    );
    expect(servers.luna.command).toBe('bun');
    expect(servers.luna.toolsAllow).toEqual(['send_message']);
    expect(servers.custom.command).toBe('custom');
  });

  test('skips external entries without command', () => {
    const servers = buildRuntimeMcpServers(
      { broken: { toolsAllow: ['x'] } },
      { command: 'bun', args: [], env: {} },
    );
    expect(servers.broken).toBeUndefined();
  });
});
