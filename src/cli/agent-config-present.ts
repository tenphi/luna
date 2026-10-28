import type { StoredContainerConfig } from '../container-config.js';

/** Format stored container config for CLI display. */
export function presentAgentConfig(config: StoredContainerConfig): Record<string, unknown> {
  return {
    provider: config.provider ?? null,
    model: config.model ?? null,
    effort: config.effort ?? null,
    image_tag: config.imageTag ?? null,
    assistant_name: config.assistantName ?? null,
    max_messages_per_prompt: config.maxMessagesPerPrompt ?? null,
    context: config.context ?? null,
    skills: config.skills,
    skills_disabled: config.skillsDisabled ?? null,
    skills_enabled: config.skillsEnabled ?? null,
    mcp_servers: config.mcpServers,
    packages_apt: config.packages.apt,
    packages_npm: config.packages.npm,
    additional_mounts: config.additionalMounts,
    cli_scope: config.cliScope ?? 'global',
  };
}
