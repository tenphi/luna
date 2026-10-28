import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { StdioProviderBridge } from '../stdio-provider.js';

export interface BuiltinServerInfo {
  name: string;
  requiresExplicitHost?: boolean;
  oneCli?: boolean;
}

export interface BuiltinPrepareResult {
  /** In-process MCP server factories (email, legacy builtins). */
  factories?: Record<string, () => McpServer>;
  /**
   * Stdio-bridged factories (e.g. install-local stdio MCP children).
   * Preferred over `factories` when both exist for the same name.
   */
  bridges?: Record<string, () => Promise<StdioProviderBridge>>;
  disabledServerNames?: Set<string>;
}

export interface BuiltinMcpProvider {
  id: string;
  isEnabled(): boolean;
  listServers(): BuiltinServerInfo[];
  prepare(): Promise<BuiltinPrepareResult>;
}
