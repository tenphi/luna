/**
 * Container config — source of truth is `agent/container.json`.
 * At spawn, `loadContainerConfig()` enriches the stored file (Mac Bridge,
 * MCP filters) and writes `.luna-container.json` for the agent-runner.
 */
import fs from 'fs';
import path from 'path';

import { getAgentDir } from './install-paths.js';
import { agentDocToStored, storedToLocalPatch, unifiedToStored } from './config/agent-bridge.js';
import { clearConfigCache, loadLunaConfig, resolveInstallDefaults, resolveRunnerProvider } from './config/loader.js';
import { localConfigExists, writeLocalConfig } from './config/write.js';
import { resolveAssistantName } from './config/unified-agent.js';
import { sessionDir } from './session-manager.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMcpToolFilters } from './db/install-settings.js';
import { mergeDefaultTavily } from './tavily-defaults.js';
import { rewriteContainerHostAliasInEnv } from './container-runtime.js';
import { mergeHostMcpRelays } from './host-mcp/defaults.js';
import { loadAppleConfig } from './host-mcp/builtins/apple/shared/config.js';
import { applyGlobalMcpToolFilters } from './mcp-tool-filters.js';
import { DEFAULT_SKILLS_DISABLED } from './container-skills.js';
import type { AgentGroup } from './types.js';

/** Apple defaults exposed to the agent-runner for session agenda injection. */
export interface ContainerAppleDefaults {
  defaultCalendar?: string | null;
  defaultRemindersList?: string | null;
}

/**
 * Neither loopback nor `host.docker.internal` reaches the host from inside Apple
 * Container. Spawn rewrites the alias in `-e` values and MCP envs; this block
 * travels as JSON, so it needs the same treatment or a local endpoint is
 * unreachable from the agent-runner.
 */

/** Install-wide default provider/model from unified config + legacy .env fallback. */
function installDefaults(): { provider?: string; model?: string } {
  return resolveInstallDefaults();
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
  /** Raw MCP tool names (allowlist). Stored in container.json; install-wide filters override at spawn. */
  toolsAllow?: string[];
  toolsIgnore?: string[];
  /** Host-routed MCP: listed in container.json, relay wired at spawn. */
  host?: boolean;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Conversation-episode (topic segmentation) settings. */
export interface TopicsConfig {
  enabled?: boolean;
  classifier?: 'decisions' | 'model';
  continueWindowMinutes?: number;
  injectCount?: number;
  mirrorToMemory?: boolean;
  summaryModel?: 'memory' | 'main';
}

/** Pre-turn attachment reading (see `container/agent-runner/src/attachment-digest.ts`). */
export interface AttachmentsConfig {
  enabled?: boolean;
  deadlineMs?: number;
  maxCharsPerAttachment?: number;
  maxBlockChars?: number;
  maxGistChars?: number;
  maxPdfPages?: number;
  ocrImages?: boolean;
  describeImages?: boolean;
}

/** OpenAI provider context budgeting and compaction (agent/container.json). */
export interface ContextOptimizationConfig {
  maxApproxTokens?: number;
  keepRecentTurns?: number;
  summarization?: 'off' | 'deterministic' | 'model';
  promptCacheKey?: string;
  topics?: TopicsConfig;
  attachments?: AttachmentsConfig;
}

function normalizeAttachmentsConfig(raw: unknown): AttachmentsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: AttachmentsConfig = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  for (const key of ['deadlineMs', 'maxCharsPerAttachment', 'maxBlockChars', 'maxGistChars', 'maxPdfPages'] as const) {
    if (o[key] !== undefined) out[key] = Number(o[key]);
  }
  if (typeof o.ocrImages === 'boolean') out.ocrImages = o.ocrImages;
  if (typeof o.describeImages === 'boolean') out.describeImages = o.describeImages;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTopicsConfig(raw: unknown): TopicsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: TopicsConfig = {};
  if (o.classifier === 'decisions' || o.classifier === 'model') out.classifier = o.classifier;
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (o.continueWindowMinutes !== undefined) out.continueWindowMinutes = Number(o.continueWindowMinutes);
  if (o.injectCount !== undefined) out.injectCount = Number(o.injectCount);
  if (typeof o.mirrorToMemory === 'boolean') out.mirrorToMemory = o.mirrorToMemory;
  if (o.summaryModel === 'memory' || o.summaryModel === 'main') out.summaryModel = o.summaryModel;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeContextConfig(raw: unknown): ContextOptimizationConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const summarization = o.summarization ?? o.summarization_mode;
  const mode =
    summarization === 'off' || summarization === 'deterministic' || summarization === 'model'
      ? summarization
      : undefined;
  const out: ContextOptimizationConfig = {};
  if (o.maxApproxTokens !== undefined || o.max_approx_tokens !== undefined) {
    out.maxApproxTokens = Number(o.maxApproxTokens ?? o.max_approx_tokens);
  }
  if (o.keepRecentTurns !== undefined || o.keep_recent_turns !== undefined) {
    out.keepRecentTurns = Number(o.keepRecentTurns ?? o.keep_recent_turns);
  }
  if (mode) out.summarization = mode;
  if (typeof o.promptCacheKey === 'string') out.promptCacheKey = o.promptCacheKey;
  if (typeof o.prompt_cache_key === 'string') out.promptCacheKey = o.prompt_cache_key;
  const topics = normalizeTopicsConfig(o.topics);
  if (topics) out.topics = topics;
  const attachments = normalizeAttachmentsConfig(o.attachments);
  if (attachments) out.attachments = attachments;
  return Object.keys(out).length > 0 ? out : undefined;
}

export type CliScope = 'disabled' | 'agent' | 'global';

/** On-disk shape in agent/container.json (user-editable). */
export interface StoredContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  /** Extra built-in skills to exclude when `skills` is `"all"`. */
  skillsDisabled?: string[];
  /** Built-in skills to include when `skills` is `"all"` (overrides default-disabled). */
  skillsEnabled?: string[];
  provider?: string;
  assistantName?: string;
  cliScope?: CliScope;
  maxMessagesPerPrompt?: number;
  context?: ContextOptimizationConfig;
  model?: string;
  effort?: string;
}

/** Runtime container config passed to the agent-runner at spawn. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  /** Extra built-in skills to exclude when `skills` is `"all"`. */
  skillsDisabled?: string[];
  /** Built-in skills to include when `skills` is `"all"` (overrides default-disabled). */
  skillsEnabled?: string[];
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
  context?: ContextOptimizationConfig;
  model?: string;
  effort?: string;
  /** Install-wide Apple calendar/reminders defaults for session auto-injection. */
  apple?: ContainerAppleDefaults;
  /** Install-wide memory behavior exposed to the agent-runner. */
  memory?: { autoRecall?: boolean };
}

export interface DefaultStoredConfigOptions {
  assistantName?: string;
  provider?: string;
  model?: string;
  cliScope?: StoredContainerConfig['cliScope'];
}

export function agentConfigPath(): string {
  return path.join(getAgentDir(), 'container.json');
}

/** Normalize legacy `group` cliScope value to `agent`. */
export function normalizeCliScope(raw: string | undefined): CliScope {
  if (raw === 'disabled' || raw === 'global') return raw;
  if (raw === 'agent' || raw === 'group') return 'agent';
  return 'agent';
}

/** Drop spawn wiring from host entries; host must not carry command/args/env. */
export function sanitizeMcpServerForStorage(cfg: McpServerConfig): McpServerConfig {
  if (!cfg.host) return { ...cfg };
  const { command: _c, args: _a, env: _e, ...rest } = cfg;
  return { ...rest, host: true };
}

function normalizeStoredMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  if (!servers) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg && typeof cfg === 'object') out[name] = sanitizeMcpServerForStorage(cfg);
  }
  return out;
}

/** Omit host-only MCP servers from runtime config passed to the agent container. */
export function omitHostMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.host) out[name] = cfg;
  }
  return out;
}

/** Normalize parsed JSON into StoredContainerConfig. */
export function normalizeStoredContainerConfig(raw: Record<string, unknown>): StoredContainerConfig {
  const packages =
    (raw.packages as StoredContainerConfig['packages'] | undefined) ??
    ({
      apt: (raw.packages_apt as string[] | undefined) ?? [],
      npm: (raw.packages_npm as string[] | undefined) ?? [],
    } as StoredContainerConfig['packages']);
  const skills = raw.skills;
  const skillsDisabled = raw.skillsDisabled ?? raw.skills_disabled;
  const skillsEnabled = raw.skillsEnabled ?? raw.skills_enabled;
  const rawCliScope = (raw.cliScope ?? raw.cli_scope) as string | undefined;

  const rawMcp =
    (raw.mcpServers as Record<string, McpServerConfig> | undefined) ??
    (raw.mcp_servers as Record<string, McpServerConfig> | undefined);

  return {
    mcpServers: normalizeStoredMcpServers(rawMcp),
    packages: {
      apt: packages?.apt ?? [],
      npm: packages?.npm ?? [],
    },
    imageTag: (raw.imageTag as string | undefined) ?? (raw.image_tag as string | undefined),
    additionalMounts: (raw.additionalMounts as AdditionalMountConfig[] | undefined) ?? [],
    skills: skills === 'all' || Array.isArray(skills) ? (skills as string[] | 'all') : 'all',
    skillsDisabled: Array.isArray(skillsDisabled) ? (skillsDisabled as string[]) : undefined,
    skillsEnabled: Array.isArray(skillsEnabled) ? (skillsEnabled as string[]) : undefined,
    provider: raw.provider as string | undefined,
    assistantName: (raw.assistantName as string | undefined) ?? (raw.assistant_name as string | undefined),
    cliScope: normalizeCliScope(rawCliScope),
    maxMessagesPerPrompt:
      (raw.maxMessagesPerPrompt as number | undefined) ?? (raw.max_messages_per_prompt as number | undefined),
    context: normalizeContextConfig(raw.context),
    model: raw.model as string | undefined,
    effort: raw.effort as string | undefined,
  };
}

export function defaultStoredContainerConfig(
  group: AgentGroup,
  opts?: DefaultStoredConfigOptions,
): StoredContainerConfig {
  const defaults = installDefaults();
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
    skillsDisabled: [...DEFAULT_SKILLS_DISABLED],
    provider: opts?.provider ?? defaults.provider,
    model: opts?.model ?? defaults.model,
    assistantName: opts?.assistantName ?? resolveAssistantName(loadLunaConfig()) ?? group.name,
    cliScope: opts?.cliScope ?? 'global',
  };
}

function withDefaultSkillsDisabled(stored: StoredContainerConfig): StoredContainerConfig {
  if (stored.skills !== 'all') return stored;

  const disabled = new Set<string>(stored.skillsDisabled ?? DEFAULT_SKILLS_DISABLED);
  for (const name of stored.skillsEnabled ?? []) {
    disabled.delete(name);
  }
  const skillsDisabled = [...disabled].sort();
  return {
    ...stored,
    skillsDisabled: skillsDisabled.length > 0 ? skillsDisabled : undefined,
  };
}

export function readStoredContainerConfig(group: AgentGroup): StoredContainerConfig {
  const cfg = loadLunaConfig();
  const hasUnified =
    cfg.models?.main !== undefined ||
    (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) ||
    (cfg.agent && Object.keys(cfg.agent).length > 0);

  if (hasUnified) {
    const fromUnified = unifiedToStored(cfg, group.name);
    const fromAgent = cfg.agent ? agentDocToStored(cfg.agent) : {};
    const merged: StoredContainerConfig = {
      ...defaultStoredContainerConfig(group),
      ...fromUnified,
      ...fromAgent,
      mcpServers: fromUnified.mcpServers,
      packages: fromAgent.packages ?? fromUnified.packages,
      additionalMounts: fromAgent.additionalMounts ?? fromUnified.additionalMounts,
      skills: fromAgent.skills ?? fromUnified.skills,
    };
    return withDefaultSkillsDisabled(merged);
  }

  const p = agentConfigPath();
  if (!fs.existsSync(p)) {
    return defaultStoredContainerConfig(group);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  return withDefaultSkillsDisabled(normalizeStoredContainerConfig(raw));
}

export function writeStoredContainerConfig(config: StoredContainerConfig): string {
  const toWrite: StoredContainerConfig = {
    mcpServers: normalizeStoredMcpServers(config.mcpServers),
    packages: {
      apt: config.packages?.apt ?? [],
      npm: config.packages?.npm ?? [],
    },
    additionalMounts: config.additionalMounts ?? [],
    skills: config.skills ?? 'all',
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...(config.imageTag !== undefined ? { imageTag: config.imageTag } : {}),
    ...(config.assistantName !== undefined ? { assistantName: config.assistantName } : {}),
    ...(config.cliScope !== undefined ? { cliScope: config.cliScope } : {}),
    ...(config.maxMessagesPerPrompt !== undefined ? { maxMessagesPerPrompt: config.maxMessagesPerPrompt } : {}),
    ...(config.context !== undefined ? { context: config.context } : {}),
    ...(config.skillsDisabled !== undefined ? { skillsDisabled: config.skillsDisabled } : {}),
    ...(config.skillsEnabled !== undefined ? { skillsEnabled: config.skillsEnabled } : {}),
  };

  const existing = loadLunaConfig();
  return writeLocalConfig(storedToLocalPatch(toWrite, existing));
}

/** Ensure local agent config exists with defaults. Returns true if the file was created. */
export function ensureAgentContainerFile(group: AgentGroup, opts?: DefaultStoredConfigOptions): boolean {
  if (!localConfigExists() && !fs.existsSync(agentConfigPath())) {
    writeStoredContainerConfig(defaultStoredContainerConfig(group, opts));
    return true;
  }
  return false;
}

/** Build runtime config from stored file + spawn-time merges. */
export function enrichForRuntime(
  stored: StoredContainerConfig,
  group: AgentGroup,
  sessionId?: string,
): ContainerConfig {
  const defaults = installDefaults();
  const withTavily = mergeDefaultTavily(stored.mcpServers);
  const withFilters = applyGlobalMcpToolFilters(withTavily, getMcpToolFilters());
  const withHostRelays = mergeHostMcpRelays(withFilters, group.id, sessionId);
  const mcpServers = omitHostMcpServers(withHostRelays);
  const appleCfg = loadAppleConfig();
  const memoryCfg = loadLunaConfig().memory ?? {};

  return {
    mcpServers,
    packages: {
      apt: stored.packages?.apt ?? [],
      npm: stored.packages?.npm ?? [],
    },
    imageTag: stored.imageTag,
    additionalMounts: stored.additionalMounts ?? [],
    skills: stored.skills ?? 'all',
    skillsDisabled: stored.skillsDisabled,
    skillsEnabled: stored.skillsEnabled,
    // The container reads this as a provider *implementation* id, so map the
    // configured `providers` entry name through its kind before writing it.
    provider: resolveRunnerProvider(stored.provider ?? defaults.provider),
    assistantName: stored.assistantName ?? group.name,
    maxMessagesPerPrompt: stored.maxMessagesPerPrompt,
    context: stored.context,
    model: stored.model ?? defaults.model ?? undefined,
    effort: stored.effort,
    apple: {
      defaultCalendar: appleCfg.apps.calendar.defaultCalendar ?? null,
      defaultRemindersList: appleCfg.apps.reminders.defaultList ?? null,
    },
    memory: {
      autoRecall: memoryCfg.enabled !== false && memoryCfg.autoRecall !== false,
    },
  };
}

/**
 * MCP config for host-side `dump-tool-schemas` probing.
 * Uses unified/local config (not legacy agent/container.json). Keeps `host: true`
 * servers with their host command so the probe can connect on macOS; spawn-time
 * relay wiring is skipped because relays only work inside a running container.
 */
export function containerConfigForToolProbe(
  group: AgentGroup,
): Pick<StoredContainerConfig, 'mcpServers' | 'additionalMounts'> {
  const stored = readStoredContainerConfig(group);
  const mcpServers = applyGlobalMcpToolFilters(mergeDefaultTavily(stored.mcpServers), getMcpToolFilters());
  return {
    mcpServers,
    additionalMounts: stored.additionalMounts ?? [],
  };
}

/** Load enriched runtime config for spawn. */
export function loadContainerConfig(agentGroupId: string, sessionId?: string): ContainerConfig {
  // Spawn must see the latest local.jsonc (manual edits skip config/write.ts).
  clearConfigCache();

  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const stored = readStoredContainerConfig(group);
  const config = enrichForRuntime(stored, group, sessionId);
  for (const server of Object.values(config.mcpServers)) {
    if (server.env) server.env = rewriteContainerHostAliasInEnv(server.env) ?? server.env;
  }
  return config;
}

/** Read stored file, merge patch, write back. */
export function updateStoredContainerConfig(
  agentGroupId: string,
  patch: Partial<StoredContainerConfig>,
): StoredContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const current = readStoredContainerConfig(group);
  const merged: StoredContainerConfig = {
    ...current,
    ...patch,
    mcpServers: patch.mcpServers ?? current.mcpServers,
    packages: patch.packages ?? current.packages,
    additionalMounts: patch.additionalMounts ?? current.additionalMounts,
  };
  writeStoredContainerConfig(merged);
  return merged;
}

/** Write spawn-time config into the session folder for the container to read. */
export function writeSessionContainerConfig(agentGroupId: string, sessionId: string, config: ContainerConfig): string {
  const p = path.join(sessionDir(agentGroupId, sessionId), '.luna-container.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  return p;
}
