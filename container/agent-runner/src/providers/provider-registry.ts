import type { AgentProvider, ProviderOptions } from './types.js';

export type ProviderFactory = (options: ProviderOptions) => AgentProvider;
const implementations: Record<string, ProviderFactory> = Object.create(null);

export function getProviderFactory(name: string): ProviderFactory {
  if (Object.hasOwn(implementations, name)) return implementations[name]!;
  throw new Error(`Unknown provider: ${name}. Registered: ${Object.keys(implementations).join(', ') || '(none)'}`);
}

export function registerProvider(name: string, create: ProviderFactory): void {
  if (Object.hasOwn(implementations, name)) throw new Error(`Provider already registered: ${name}`);
  implementations[name] = create;
}
