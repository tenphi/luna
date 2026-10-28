import { BUILTIN_PROVIDERS } from './builtins/index.js';
import { loadHostMcpInstallConfig } from './shared/config.js';
import type { HostMcpProviderDefinition, HostMcpRegistry } from './types.js';

function builtinProviders(): Record<string, HostMcpProviderDefinition> {
  const out: Record<string, HostMcpProviderDefinition> = {};
  for (const provider of BUILTIN_PROVIDERS) {
    if (!provider.isEnabled()) continue;
    for (const server of provider.listServers()) {
      out[server.name] = {
        name: server.name,
        kind: 'builtin',
        requiresExplicitHost: server.requiresExplicitHost ?? false,
        oneCli: server.oneCli ?? false,
      };
    }
  }
  return out;
}

function stdioProviders(): { port: number; providers: Record<string, HostMcpProviderDefinition> } {
  const config = loadHostMcpInstallConfig();
  const out: Record<string, HostMcpProviderDefinition> = {};
  for (const [name, server] of Object.entries(config.servers)) {
    out[name] = {
      name,
      kind: 'stdio',
      requiresExplicitHost: true,
      oneCli: server.oneCli !== false,
    };
  }
  return { port: config.port, providers: out };
}

export function buildHostMcpRegistry(): HostMcpRegistry {
  const stdio = stdioProviders();
  return {
    port: stdio.port,
    providers: {
      ...builtinProviders(),
      ...stdio.providers,
    },
  };
}
