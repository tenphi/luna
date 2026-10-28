import type { LunaConfigDoc, McpServerConfigDoc } from './schema.js';

function mergeMcpEntry(
  base: McpServerConfigDoc | undefined,
  overlay: McpServerConfigDoc | undefined,
): McpServerConfigDoc | undefined {
  if (!base) return overlay ? { ...overlay } : undefined;
  if (!overlay) return { ...base };
  return { ...base, ...overlay };
}

/**
 * Collapse legacy shapes (agent.mcpServers, install/agent duplicates)
 * into the canonical top-level fields after layer merge.
 */
export function normalizeLunaConfig(doc: LunaConfigDoc): LunaConfigDoc {
  const out: LunaConfigDoc = { ...doc };

  const mcp: Record<string, McpServerConfigDoc> = { ...(out.mcpServers ?? {}) };
  for (const [name, cfg] of Object.entries(out.agent?.mcpServers ?? {})) {
    const merged = mergeMcpEntry(mcp[name], cfg);
    if (merged) mcp[name] = merged;
  }
  if (Object.keys(mcp).length > 0) out.mcpServers = mcp;

  if (out.install?.assistantName === undefined && out.agent?.assistantName) {
    out.install = { ...out.install, assistantName: out.agent.assistantName };
  }

  return out;
}
