import { loadLunaConfig } from '../../config/loader.js';
import { patchLocalConfig } from '../../config/write.js';
import type { McpServerConfigDoc } from '../../config/schema.js';
import { log } from '../../log.js';

export interface HostMcpStdioServerConfig {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  oneCli?: boolean;
}

export interface HostMcpInstallConfig {
  port: number;
  servers: Record<string, HostMcpStdioServerConfig>;
}

export const DEFAULT_HOST_MCP_PORT = 18800;

function normalizeServerConfig(raw: McpServerConfigDoc): HostMcpStdioServerConfig | null {
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  if (!command || !cwd) return null;
  return {
    command,
    cwd,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
    env: raw.env ?? {},
    oneCli: raw.oneCli === undefined ? true : raw.oneCli !== false,
  };
}

function parsePort(raw: unknown): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 65535) return raw;
  return DEFAULT_HOST_MCP_PORT;
}

export function loadHostMcpInstallConfig(): HostMcpInstallConfig {
  const unified = loadLunaConfig();
  const port = parsePort(unified.mcpPort);
  const servers: Record<string, HostMcpStdioServerConfig> = {};

  for (const [name, cfg] of Object.entries(unified.mcpServers ?? {})) {
    if (!cfg.host) continue;
    const normalized = normalizeServerConfig(cfg);
    if (!normalized) {
      log.warn('Ignoring invalid host MCP server config', { name, configPath: 'unified-config' });
      continue;
    }
    servers[name] = normalized;
  }

  return { port, servers };
}

export function setHostMcpServer(name: string, server: HostMcpStdioServerConfig): HostMcpInstallConfig {
  const unified = loadLunaConfig();
  const mcpServers = { ...(unified.mcpServers ?? {}) };
  mcpServers[name] = {
    host: true,
    command: server.command,
    cwd: server.cwd,
    args: server.args ?? [],
    env: server.env ?? {},
    oneCli: server.oneCli ?? true,
    ...(mcpServers[name]?.toolsAllow ? { toolsAllow: mcpServers[name]!.toolsAllow } : {}),
    ...(mcpServers[name]?.toolsIgnore ? { toolsIgnore: mcpServers[name]!.toolsIgnore } : {}),
  };
  patchLocalConfig('mcpServers', mcpServers);
  return loadHostMcpInstallConfig();
}

export function removeHostMcpServer(name: string): HostMcpInstallConfig {
  const unified = loadLunaConfig();
  const mcpServers = { ...(unified.mcpServers ?? {}) };
  if (!(name in mcpServers)) return loadHostMcpInstallConfig();
  delete mcpServers[name];
  patchLocalConfig('mcpServers', mcpServers);
  return loadHostMcpInstallConfig();
}

export function setHostMcpPort(port: number): HostMcpInstallConfig {
  patchLocalConfig('mcpPort', parsePort(port));
  return loadHostMcpInstallConfig();
}
