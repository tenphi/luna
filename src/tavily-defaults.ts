/**
 * Install-wide Tavily web-search defaults.
 *
 * `tavily-mcp` is baked into the agent image (container/Dockerfile) and the
 * host forwards `TAVILY_API_KEY` into every container (container-runner.ts).
 * The only remaining piece is exposing the MCP server to the agent — which we
 * do automatically here, gated purely on the key being present in `.env`.
 *
 * No API key → no server (so keyless installs don't spawn a tavily-mcp that
 * would fail on startup). Set the key via `luna setup step tavily` (or add it
 * to `.env` directly) and the next container spawn picks it up.
 */
import type { McpServerConfig } from './container-config.js';
import { readEnvFile } from './env.js';

/** MCP server name the agent sees (tools are `mcp__tavily__*`). */
export const TAVILY_SERVER_NAME = 'tavily';

/** True when a Tavily API key is available (process env wins over `.env`). */
export function isTavilyEnabled(): boolean {
  const fromProcess = process.env.TAVILY_API_KEY;
  if (fromProcess !== undefined && fromProcess !== '') return true;
  return !!readEnvFile(['TAVILY_API_KEY']).TAVILY_API_KEY;
}

export function defaultTavilyMcpServer(): McpServerConfig {
  // No `env` — the host injects TAVILY_API_KEY into the container at spawn
  // (see buildContainerArgs in container-runner.ts), so the key never lands
  // in container.json / .luna-container.json.
  return {
    command: 'tavily-mcp',
    args: [],
  };
}

/**
 * Merge the default Tavily server into per-group mcp_servers. Skips when no
 * API key is configured, when a group opts out (`env.TAVILY_DISABLED=true`),
 * or when a group already points `tavily` at a non-default command.
 */
export function mergeDefaultTavily(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  if (!isTavilyEnabled()) return servers;

  const existing = servers[TAVILY_SERVER_NAME];
  if (existing?.env?.TAVILY_DISABLED === 'true') return servers;
  if (existing?.command && existing.command !== 'tavily-mcp') return servers;

  const defaults = defaultTavilyMcpServer();
  return {
    ...servers,
    [TAVILY_SERVER_NAME]: {
      ...defaults,
      ...existing,
      command: defaults.command,
      args: existing?.args ?? defaults.args,
    },
  };
}
