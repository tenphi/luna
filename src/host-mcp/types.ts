export interface HostMcpProviderDefinition {
  name: string;
  kind: 'builtin' | 'stdio';
  requiresExplicitHost: boolean;
  oneCli: boolean;
}

export interface HostMcpRegistry {
  port: number;
  providers: Record<string, HostMcpProviderDefinition>;
}
