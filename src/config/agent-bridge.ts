import type { StoredContainerConfig } from '../container-config.js';
import { sanitizeAgentForLocalOverlay, sanitizeLocalDocument } from './sanitize.js';
import type { AgentConfigDoc, LunaConfigDoc } from './schema.js';
import { containerMcpFromUnified, mcpServersToDoc, resolveProviderModel } from './unified-agent.js';

/** Map unified agent section to StoredContainerConfig fields (skills, packages, etc.). */
export function agentDocToStored(doc: AgentConfigDoc): Partial<StoredContainerConfig> {
  return {
    ...(doc.effort !== undefined && doc.effort !== null ? { effort: doc.effort } : {}),
    ...(doc.imageTag !== undefined && doc.imageTag !== null ? { imageTag: doc.imageTag } : {}),
    ...(doc.maxMessagesPerPrompt !== undefined ? { maxMessagesPerPrompt: doc.maxMessagesPerPrompt } : {}),
    ...(doc.context !== undefined ? { context: doc.context } : {}),
    ...(doc.skills !== undefined ? { skills: doc.skills } : {}),
    ...(doc.skillsDisabled !== undefined ? { skillsDisabled: doc.skillsDisabled } : {}),
    ...(doc.skillsEnabled !== undefined ? { skillsEnabled: doc.skillsEnabled } : {}),
    ...(doc.packages !== undefined ? { packages: { apt: doc.packages.apt ?? [], npm: doc.packages.npm ?? [] } } : {}),
    ...(doc.additionalMounts !== undefined ? { additionalMounts: doc.additionalMounts } : {}),
  };
}

/** Build stored config from normalized unified config. */
export function unifiedToStored(cfg: LunaConfigDoc, groupName: string): StoredContainerConfig {
  const { provider, model } = resolveProviderModel(cfg);
  return {
    mcpServers: containerMcpFromUnified(cfg.mcpServers),
    packages: { apt: cfg.agent?.packages?.apt ?? [], npm: cfg.agent?.packages?.npm ?? [] },
    additionalMounts: cfg.agent?.additionalMounts ?? [],
    skills: cfg.agent?.skills ?? 'all',
    skillsDisabled: cfg.agent?.skillsDisabled,
    skillsEnabled: cfg.agent?.skillsEnabled,
    provider,
    model,
    effort: cfg.agent?.effort ?? undefined,
    imageTag: cfg.agent?.imageTag ?? undefined,
    assistantName: cfg.install?.assistantName ?? groupName,
    ...(cfg.agent?.cliScope !== undefined
      ? { cliScope: cfg.agent.cliScope === 'group' ? 'agent' : cfg.agent.cliScope }
      : {}),
    maxMessagesPerPrompt: cfg.agent?.maxMessagesPerPrompt,
    context: cfg.agent?.context,
  };
}

/** Map stored container config to local overlay patch (defaults stripped). */
export function storedToLocalPatch(config: StoredContainerConfig, existing: LunaConfigDoc): LunaConfigDoc {
  const agentRaw: AgentConfigDoc = {
    packages: config.packages,
    additionalMounts: config.additionalMounts,
    skills: config.skills,
    skillsDisabled: config.skillsDisabled,
    skillsEnabled: config.skillsEnabled,
    effort: config.effort,
    imageTag: config.imageTag,
    maxMessagesPerPrompt: config.maxMessagesPerPrompt,
    context: config.context,
  };
  const agent = sanitizeAgentForLocalOverlay(agentRaw);
  if (config.packages.apt.length === 0 && config.packages.npm.length === 0) {
    agent.packages = { apt: [], npm: [] };
  }
  if (config.additionalMounts.length === 0) agent.additionalMounts = [];

  const mcpServers = mcpServersToDoc(config.mcpServers, existing.mcpServers);
  const patch: LunaConfigDoc = {
    ...(config.assistantName !== undefined
      ? { install: { ...existing.install, assistantName: config.assistantName } }
      : {}),
    ...(config.provider !== undefined || config.model !== undefined
      ? {
          models: {
            ...existing.models,
            main: {
              ...existing.models?.main,
              ...(config.provider !== undefined ? { provider: config.provider } : {}),
              ...(config.model !== undefined ? { id: config.model } : {}),
            },
          },
        }
      : {}),
    mcpServers,
    agent,
  };

  const sanitized = sanitizeLocalDocument(patch);
  // Preserve explicit MCP clears (sanitize drops empty mcpServers).
  if (Object.keys(mcpServers).length === 0 && existing.mcpServers && Object.keys(existing.mcpServers).length > 0) {
    return { ...sanitized, mcpServers: {} };
  }
  return sanitized;
}
