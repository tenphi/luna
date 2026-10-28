import { OneCLI } from '@onecli-sh/sdk';
import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from '../../config.js';
import type { ContainerConfig } from '../../container-config.js';
import { hostGatewayArgs, readonlyMountArgs, rewriteContainerHostAliasInArgs } from '../../container-runtime.js';
import { readEnvFile } from '../../env.js';
import { appendHostMcpNoProxyToContainerArgs } from '../../host-mcp/defaults.js';
import { buildHostMcpRegistry } from '../../host-mcp/registry.js';
import { sessionTokenServerName } from '../../host-mcp/session-api.js';
import { readOrCreatePairToken } from '../../host-mcp/tokens.js';
import { hostReachableNetwork } from '../../onecli-runtime.js';
import type { ProviderContainerContribution, VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../../types.js';

const gateway = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

export async function containerArguments(
  name: string,
  group: AgentGroup,
  session: Session,
  settings: ContainerConfig,
  contribution: ProviderContainerContribution,
  mounts: VolumeMount[],
): Promise<string[]> {
  const arguments_ = ['run', '--rm', '--name', name, '--label', CONTAINER_INSTALL_LABEL];
  const network = hostReachableNetwork();
  if (network) arguments_.push('--network', network);
  const registry = buildHostMcpRegistry();
  const token = readOrCreatePairToken(group.id, sessionTokenServerName(session.id));
  const environment: Record<string, string> = {
    TZ: TIMEZONE,
    LUNA_SESSION_API_URL: `http://host.docker.internal:${registry.port}/session/${group.id}/${session.id}`,
    LUNA_SESSION_TOKEN: token,
    ...readEnvFile(['TAVILY_API_KEY']),
    ...contribution.env,
  };
  for (const [key, value] of Object.entries(environment)) arguments_.push('-e', `${key}=${value}`);
  await gateway.ensureAgent({ name: group.name, identifier: group.id });
  if (!(await gateway.applyContainerConfig(arguments_, { addHostMapping: false, agent: group.id }))) {
    throw new Error('The credential gateway is unavailable; container startup was refused');
  }
  rewriteContainerHostAliasInArgs(arguments_);
  appendHostMcpNoProxyToContainerArgs(arguments_);
  arguments_.push(...hostGatewayArgs());
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0 && uid !== 1000)
    arguments_.push('--user', `${uid}:${process.getgid?.()}`, '-e', 'HOME=/home/node');
  for (const mount of mounts) {
    arguments_.push(
      ...(mount.readonly
        ? readonlyMountArgs(mount.hostPath, mount.containerPath)
        : ['-v', `${mount.hostPath}:${mount.containerPath}`]),
    );
  }
  arguments_.push('--entrypoint', 'bash', settings.imageTag || CONTAINER_IMAGE, '-c', 'exec bun /app/src/index.ts');
  return arguments_;
}
