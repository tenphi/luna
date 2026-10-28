import type { McpServerConfig } from '../container-config.js';
import type { LunaConfigDoc, McpServerConfigDoc } from './schema.js';

function stripHostWiring(cfg: McpServerConfigDoc): McpServerConfig {
  if (!cfg.host) return { ...cfg };
  const { command: _c, args: _a, env: _e, cwd: _d, oneCli: _o, ...rest } = cfg;
  return { ...rest, host: true };
}

export function resolveAssistantName(cfg: LunaConfigDoc): string | undefined {
  return cfg.install?.assistantName ?? cfg.agent?.assistantName ?? undefined;
}

export function resolveProviderModel(cfg: LunaConfigDoc): { provider?: string; model?: string } {
  const main = cfg.models?.main;
  return {
    provider: main?.provider?.trim() || cfg.agent?.provider || undefined,
    model: main?.id?.trim() || cfg.agent?.model || undefined,
  };
}

/** Container-facing MCP entries (host wiring omitted). */
export function containerMcpFromUnified(
  servers: Record<string, McpServerConfigDoc> | undefined,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (cfg.host) {
      out[name] = stripHostWiring(cfg);
    } else {
      out[name] = { ...cfg };
    }
  }
  return out;
}

/** Full on-disk MCP map (retains host wiring for external servers). */
export function mcpServersToDoc(
  stored: Record<string, McpServerConfig>,
  existing: Record<string, McpServerConfigDoc> | undefined,
): Record<string, McpServerConfigDoc> {
  const out: Record<string, McpServerConfigDoc> = {};
  for (const [name, cfg] of Object.entries(stored)) {
    if (cfg.host) {
      const host = existing?.[name];
      out[name] = {
        host: true,
        ...(cfg.toolsAllow ? { toolsAllow: cfg.toolsAllow } : {}),
        ...(cfg.toolsIgnore ? { toolsIgnore: cfg.toolsIgnore } : {}),
        ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
        ...(host?.command ? { command: host.command } : {}),
        ...(host?.cwd ? { cwd: host.cwd } : {}),
        ...(host?.args ? { args: host.args } : {}),
        ...(host?.env ? { env: host.env } : {}),
        ...(host?.oneCli !== undefined ? { oneCli: host.oneCli } : {}),
      };
    } else {
      out[name] = { ...cfg };
    }
  }
  return out;
}
