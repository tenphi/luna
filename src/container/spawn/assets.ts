import fs from 'node:fs';
import path from 'node:path';
import { initAgentFilesystem } from '../../agent-init.js';
import { composeAgentsMd } from '../../agents-md-compose.js';
import { getAgentDir } from '../../config.js';
import type { ContainerConfig } from '../../container-config.js';
import { resolveContainerSkills } from '../../container-skills.js';
import { validateAdditionalMounts } from '../../modules/mount-security/index.js';
import type { ProviderContainerContribution, VolumeMount } from '../../providers/provider-container-registry.js';
import { sessionDir, sessionsBaseDir } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';

function skills(state: string, selected: string[]): void {
  const directory = path.join(state, 'skills');
  fs.mkdirSync(directory, { recursive: true });
  const wanted = new Set(selected);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && !wanted.has(entry.name)) fs.unlinkSync(path.join(directory, entry.name));
  }
  for (const name of wanted) {
    const destination = path.join(directory, name);
    try {
      fs.lstatSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.symlinkSync(`/app/skills/${name}`, destination);
    }
  }
}

/** Mutable install state and immutable runtime assets receive separate mounts. */
export function prepareMounts(
  group: AgentGroup,
  session: Session,
  settings: ContainerConfig,
  provider: ProviderContainerContribution,
): VolumeMount[] {
  initAgentFilesystem(group);
  composeAgentsMd(group);
  const sharedState = path.join(sessionsBaseDir(), group.id, '.agents-shared');
  skills(sharedState, resolveContainerSkills(settings));
  const workspace = path.resolve(getAgentDir());
  const tree = path.resolve('container');
  const entries: VolumeMount[] = [
    { containerPath: '/workspace', hostPath: sessionDir(group.id, session.id), readonly: false },
    { containerPath: '/workspace/agent', hostPath: workspace, readonly: false },
    { containerPath: '/home/node/.agents', hostPath: sharedState, readonly: false },
    { containerPath: '/app/src', hostPath: path.join(tree, 'agent-runner', 'src'), readonly: true },
  ];
  const optional = [
    { source: path.join(workspace, '.agents-fragments'), target: '/workspace/agent/.agents-fragments' },
    { source: tree, target: '/app/container-tree', requires: path.join(tree, 'AGENTS.md') },
    { source: path.join(tree, 'skills'), target: '/app/skills' },
  ];
  for (const item of optional) {
    if (fs.existsSync(item.requires ?? item.source))
      entries.push({ hostPath: item.source, containerPath: item.target, readonly: true });
  }
  entries.push(...validateAdditionalMounts(settings.additionalMounts ?? [], group.name), ...(provider.mounts ?? []));
  return entries;
}
