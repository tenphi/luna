import { getProviderFactory } from './provider-registry.js';
import type { AgentProvider, ProviderOptions } from './types.js';

export type ProviderName = string;
export const createProvider = (name: ProviderName, options: ProviderOptions = {}): AgentProvider => {
  const construct = getProviderFactory(name);
  return construct(options);
};
