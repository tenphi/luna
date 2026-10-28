/**
 * Per-MCP-server tool allow/ignore filtering.
 *
 * Tool names are raw MCP names (e.g. `search`), not exposed `mcp__server__tool`
 * prefixes. Policy lives on each entry in container.json / mcp_servers JSON.
 */

export interface McpToolFilterPolicy {
  toolsAllow?: string[];
  toolsIgnore?: string[];
}

export function hasMcpToolFilter(policy?: McpToolFilterPolicy): boolean {
  if (!policy) return false;
  return policy.toolsAllow !== undefined || (policy.toolsIgnore?.length ?? 0) > 0;
}

/**
 * Filter MCP tool names for a server.
 *
 * - No policy or both lists omitted/empty ignore: all names (minus ignore if set).
 * - toolsAllow present (including []): allowlist only, then apply toolsIgnore.
 * - toolsAllow omitted: all names minus toolsIgnore.
 */
export function filterMcpToolNames(allNames: string[], policy?: McpToolFilterPolicy): string[] {
  if (!policy) return [...allNames];

  const allowSet = policy.toolsAllow;
  const ignoreSet = new Set(policy.toolsIgnore ?? []);

  let names: string[];
  if (allowSet !== undefined) {
    const allow = new Set(allowSet);
    names = allNames.filter((n) => allow.has(n));
  } else {
    names = [...allNames];
  }

  if (ignoreSet.size > 0) {
    names = names.filter((n) => !ignoreSet.has(n));
  }

  return names;
}

export interface FilterMcpToolNamesResult {
  filtered: string[];
  /** Names in toolsAllow that were not found on the server. */
  unknownAllow: string[];
}

/**
 * Like filterMcpToolNames but reports allowlist entries that did not match
 * any tool on the server (helps catch typos in config).
 */
export function filterMcpToolNamesWithWarnings(
  allNames: string[],
  policy?: McpToolFilterPolicy,
): FilterMcpToolNamesResult {
  const filtered = filterMcpToolNames(allNames, policy);
  const unknownAllow: string[] = [];
  if (policy?.toolsAllow !== undefined) {
    const available = new Set(allNames);
    for (const name of policy.toolsAllow) {
      if (!available.has(name)) unknownAllow.push(name);
    }
  }
  return { filtered, unknownAllow };
}
