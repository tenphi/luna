/** Host contributions are evaluated for each container launch. */
export type VolumeMount = { containerPath: string; hostPath: string; readonly: boolean };
export type ProviderContainerContext = { agentGroupId: string; sessionDir: string; hostEnv: NodeJS.ProcessEnv };
export type ProviderContainerContribution = { env?: Record<string, string>; mounts?: VolumeMount[] };
export type ProviderContainerConfigFn = (context: ProviderContainerContext) => ProviderContainerContribution;

const contributions: Record<string, ProviderContainerConfigFn> = Object.create(null);

export function registerProviderContainerConfig(name: string, configure: ProviderContainerConfigFn): void {
  if (Object.hasOwn(contributions, name)) throw new Error(`Provider container config already registered: ${name}`);
  contributions[name] = configure;
}

export const getProviderContainerConfig = (name: string): ProviderContainerConfigFn | undefined => contributions[name];
