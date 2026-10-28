import type { McpServerConfig } from './container-config.js';

/** Install-wide tool filter for one MCP server (raw MCP tool names). */
export interface McpToolFilterPolicy {
  toolsAllow?: string[];
  toolsIgnore?: string[];
}

export type McpToolFiltersByServer = Record<string, McpToolFilterPolicy>;

export function hasMcpToolFilter(policy?: McpToolFilterPolicy): boolean {
  if (!policy) return false;
  return policy.toolsAllow !== undefined || (policy.toolsIgnore?.length ?? 0) > 0;
}

function mergePolicyOntoServer(existing: McpServerConfig | undefined, policy: McpToolFilterPolicy): McpServerConfig {
  const base = existing ? { ...existing } : {};
  return {
    ...base,
    toolsAllow: policy.toolsAllow,
    toolsIgnore: policy.toolsIgnore,
  };
}

/**
 * Apply install-wide MCP tool filters onto a group's mcp_servers map for
 * materialized container.json. Wiring (command/args/env) stays per-group;
 * filters come only from install_settings.
 */
export function applyGlobalMcpToolFilters(
  perGroupMcpServers: Record<string, McpServerConfig>,
  globalFilters: McpToolFiltersByServer,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(perGroupMcpServers)) {
    out[name] = { ...cfg };
  }

  for (const [serverName, policy] of Object.entries(globalFilters)) {
    if (!hasMcpToolFilter(policy)) continue;

    if (serverName === 'luna') {
      out.luna = mergePolicyOntoServer(out.luna, policy);
      continue;
    }

    const cfg = out[serverName];
    if (!cfg || (!cfg.command && !cfg.host)) continue;
    out[serverName] = mergePolicyOntoServer(cfg, policy);
  }

  return out;
}

/** Strip toolsAllow/toolsIgnore from a per-group mcp_servers map (DB storage). */
export function stripMcpToolFiltersFromServers(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const { toolsAllow: _a, toolsIgnore: _i, ...rest } = cfg;
    if (Object.keys(rest).length > 0) out[name] = rest;
  }
  return out;
}
