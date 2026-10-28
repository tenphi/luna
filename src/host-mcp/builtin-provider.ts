import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BUILTIN_PROVIDERS } from './builtins/index.js';
import type { StdioProviderBridge } from './stdio-provider.js';

export interface BuiltinProviderRuntime {
  factories: Record<string, () => McpServer>;
  bridges: Record<string, () => Promise<StdioProviderBridge>>;
  disabledServerNames: Set<string>;
}

export async function prepareBuiltinProviders(): Promise<BuiltinProviderRuntime> {
  const factories: Record<string, () => McpServer> = {};
  const bridges: Record<string, () => Promise<StdioProviderBridge>> = {};
  const disabledServerNames = new Set<string>();

  for (const provider of BUILTIN_PROVIDERS) {
    if (!provider.isEnabled()) continue;
    const runtime = await provider.prepare();
    if (runtime.factories) Object.assign(factories, runtime.factories);
    if (runtime.bridges) Object.assign(bridges, runtime.bridges);
    for (const name of runtime.disabledServerNames ?? []) {
      disabledServerNames.add(name);
    }
  }

  return { factories, bridges, disabledServerNames };
}
