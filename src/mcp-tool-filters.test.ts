import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from './container-config.js';
import { applyGlobalMcpToolFilters, hasMcpToolFilter, stripMcpToolFiltersFromServers } from './mcp-tool-filters.js';

describe('applyGlobalMcpToolFilters', () => {
  it('applies luna filters even when luna is not in per-group mcp_servers', () => {
    const out = applyGlobalMcpToolFilters(
      { notes: { command: 'notes-mcp', args: ['serve'] } },
      { luna: { toolsAllow: ['send_message'] } },
    );
    expect(out.luna?.toolsAllow).toEqual(['send_message']);
    expect(out.notes?.toolsAllow).toBeUndefined();
  });

  it('applies global filters only when server is wired in the group', () => {
    const out = applyGlobalMcpToolFilters(
      { notes: { command: 'notes-mcp', args: [] } },
      {
        notes: { toolsAllow: ['search'] },
        vulpine: { toolsAllow: ['summary'] },
      },
    );
    expect(out.notes?.toolsAllow).toEqual(['search']);
    expect(out.vulpine).toBeUndefined();
  });

  it('applies global filters to host servers without command', () => {
    const out = applyGlobalMcpToolFilters(
      { vulpine: { host: true, toolsAllow: ['old'] } },
      { vulpine: { toolsAllow: ['summary'] } },
    );
    expect(out.vulpine?.host).toBe(true);
    expect(out.vulpine?.toolsAllow).toEqual(['summary']);
    expect(out.vulpine?.command).toBeUndefined();
  });

  it('does not apply install filter when server has no command (file filters kept)', () => {
    const out = applyGlobalMcpToolFilters(
      { notes: { toolsAllow: ['old'], toolsIgnore: ['x'] } as McpServerConfig },
      { notes: { toolsAllow: ['search'] } },
    );
    expect(out.notes?.toolsAllow).toEqual(['old']);
    expect(out.notes?.toolsIgnore).toEqual(['x']);
    expect(out.notes?.command).toBeUndefined();
  });

  it('install filter overrides per-file toolsAllow when server is wired', () => {
    const out = applyGlobalMcpToolFilters(
      { notes: { command: 'notes-mcp', toolsAllow: ['old'] } },
      { notes: { toolsAllow: ['search'] } },
    );
    expect(out.notes?.toolsAllow).toEqual(['search']);
  });
});

describe('hasMcpToolFilter', () => {
  it('detects allow or ignore', () => {
    expect(hasMcpToolFilter({ toolsAllow: [] })).toBe(true);
    expect(hasMcpToolFilter({ toolsIgnore: ['x'] })).toBe(true);
    expect(hasMcpToolFilter({})).toBe(false);
  });
});

describe('stripMcpToolFiltersFromServers', () => {
  it('removes filter fields', () => {
    const out = stripMcpToolFiltersFromServers({
      notes: { command: 'g', toolsAllow: ['a'], toolsIgnore: ['b'] },
    });
    expect(out.notes).toEqual({ command: 'g' });
  });
});
