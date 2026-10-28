/**
 * Assemble the runtime mcpServers map: hardcoded luna process + external
 * servers from container.json, merging filter-only `luna` DB entries.
 */
import type { McpServerConfig } from '../providers/types.js';
import type { McpToolFilterPolicy } from './filter-tools.js';

export interface LunaMcpProcessConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** DB / container.json shape — `command` optional for filter-only `luna`. */
export type McpServerConfigInput = McpToolFilterPolicy & {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export function buildRuntimeMcpServers(
  configMcpServers: Record<string, McpServerConfigInput>,
  lunaProcess: LunaMcpProcessConfig,
): Record<string, McpServerConfig> {
  const lunaFilters = configMcpServers.luna;
  const mcpServers: Record<string, McpServerConfig> = {
    luna: {
      command: lunaProcess.command,
      args: lunaProcess.args,
      env: lunaProcess.env,
      toolsAllow: lunaFilters?.toolsAllow,
      toolsIgnore: lunaFilters?.toolsIgnore,
    },
  };

  for (const [name, serverConfig] of Object.entries(configMcpServers)) {
    if (name === 'luna') continue;
    if (!serverConfig.command) continue;
    mcpServers[name] = {
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      env: serverConfig.env ?? {},
      toolsAllow: serverConfig.toolsAllow,
      toolsIgnore: serverConfig.toolsIgnore,
    };
  }

  return mcpServers;
}
