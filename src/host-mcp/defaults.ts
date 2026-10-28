import { CONTAINER_HOST_GATEWAY } from '../container-runtime.js';
import type { McpServerConfig } from '../container-config.js';
import { getMcpToolFilters } from '../db/install-settings.js';
import { loadMailConfig } from './builtins/email/shared/config.js';
import { EMAIL_SERVER_KEY } from './builtins/email/shared/types.js';
import { buildHostMcpRegistry } from './registry.js';
import { readOrCreatePairToken } from './tokens.js';

function defaultBuiltinToolsAllow(serverName: string): string[] | undefined {
  if (serverName === EMAIL_SERVER_KEY) {
    return loadMailConfig().toolsAllow;
  }
  return undefined;
}

function resolveRelayToolsAllow(serverName: string, existing?: McpServerConfig): string[] | undefined {
  const global = getMcpToolFilters()[serverName]?.toolsAllow;
  if (global !== undefined) return global;
  if (existing?.toolsAllow !== undefined) return existing.toolsAllow;
  return defaultBuiltinToolsAllow(serverName);
}

export function isMcpServerDisabled(existing?: McpServerConfig): boolean {
  return existing?.env?.MCP_DISABLE === 'true';
}

/**
 * Will a given host-MCP server's tools be present in the next spawn?
 *
 * Same gate as `mergeHostMcpRelays` below, minus the token/relay side effects,
 * so callers that only need the yes/no (AGENTS.md composition deciding whether
 * to inject a fragment about those tools) can ask without wiring anything.
 * A stored entry with its own `command` still exposes tools under that name —
 * the operator replaced the relay, not the server.
 */
export function isHostMcpServerWired(servers: Record<string, McpServerConfig>, name: string): boolean {
  const provider = buildHostMcpRegistry().providers[name];
  if (!provider) return false;
  const existing = servers[name];
  if (provider.requiresExplicitHost) return existing?.host === true;
  return !isMcpServerDisabled(existing);
}

export function mergeHostMcpRelays(
  servers: Record<string, McpServerConfig>,
  agentGroupId: string,
  sessionId?: string,
): Record<string, McpServerConfig> {
  const registry = buildHostMcpRegistry();
  const out: Record<string, McpServerConfig> = { ...servers };

  for (const [name, provider] of Object.entries(registry.providers)) {
    const existing = out[name];
    const explicitHost = existing?.host === true;
    const hasCommand = Boolean(existing?.command);

    if (provider.requiresExplicitHost && !explicitHost) continue;
    if (!provider.requiresExplicitHost) {
      if (isMcpServerDisabled(existing)) continue;
      if (hasCommand) continue;
    }

    const token = readOrCreatePairToken(agentGroupId, name);
    const merged: McpServerConfig = {
      ...existing,
      command: 'bun',
      args: ['run', '/app/src/mcp-http-relay.ts'],
      env: {
        ...(existing?.env ?? {}),
        MCP_RELAY_URL: `http://host.docker.internal:${registry.port}/mcp/${agentGroupId}/${name}`,
        MCP_RELAY_TOKEN: token,
        MCP_RELAY_SERVER_NAME: name,
        // So a host tool handed `/workspace/inbox/m-42/bill.pdf` can resolve it against the
        // mount it came from. Omitted rather than faked when the caller has no session.
        ...(sessionId ? { MCP_RELAY_SESSION_ID: sessionId } : {}),
      },
      toolsAllow: resolveRelayToolsAllow(name, existing),
      toolsIgnore: getMcpToolFilters()[name]?.toolsIgnore ?? existing?.toolsIgnore,
    };
    delete merged.host;
    out[name] = merged;
  }

  return out;
}

/** Hosts that must bypass OneCLI HTTPS_PROXY for host-MCP relays. */
export function hostMcpNoProxyHosts(): readonly string[] {
  return ['host.docker.internal', CONTAINER_HOST_GATEWAY, '127.0.0.1', 'localhost'];
}

export function appendHostMcpNoProxyToContainerArgs(args: string[]): void {
  const extra: string[] = [...hostMcpNoProxyHosts()];
  const keys = ['NO_PROXY', 'no_proxy'] as const;

  for (const key of keys) {
    let merged: string[] = [...extra];
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '-e') continue;
      const entry = args[i + 1];
      if (!entry.startsWith(`${key}=`)) continue;
      found = true;
      const existing = entry.slice(key.length + 1);
      merged = [
        ...new Set([
          ...existing
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean),
          ...extra,
        ]),
      ];
      args[i + 1] = `${key}=${merged.join(',')}`;
      break;
    }
    if (!found) {
      args.push('-e', `${key}=${merged.join(',')}`);
    }
  }
}
