import { getDb } from './connection.js';
import type { McpToolFilterPolicy, McpToolFiltersByServer } from '../mcp-tool-filters.js';

const ROW_ID = 1;

export interface InstallSettingsRow {
  id: number;
  mcp_tool_filters: string;
  updated_at: string;
}

export function getMcpToolFilters(): McpToolFiltersByServer {
  const row = getDb().prepare('SELECT mcp_tool_filters FROM install_settings WHERE id = ?').get(ROW_ID) as
    Pick<InstallSettingsRow, 'mcp_tool_filters'> | undefined;
  if (!row) return {};
  return JSON.parse(row.mcp_tool_filters) as McpToolFiltersByServer;
}

/** Replace the full install-wide MCP tool filter map. */
export function setMcpToolFiltersAll(filters: McpToolFiltersByServer): void {
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE install_settings SET mcp_tool_filters = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(filters), now, ROW_ID);
}

/** Update filters for one MCP server name (merge into existing map). */
export function updateMcpToolFilterForServer(serverName: string, policy: McpToolFilterPolicy): void {
  const filters = getMcpToolFilters();
  filters[serverName] = policy;
  setMcpToolFiltersAll(filters);
}

/** Remove an MCP server entry from the global filter map. */
export function removeMcpToolFilterForServer(serverName: string): void {
  const filters = getMcpToolFilters();
  if (!(serverName in filters)) return;
  delete filters[serverName];
  setMcpToolFiltersAll(filters);
}
