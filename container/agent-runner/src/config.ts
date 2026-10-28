/**
 * Runner config — reads /workspace/.luna-container.json at startup.
 *
 * The host writes this file into the session folder on each wake. All
 * Luna-specific configuration lives here instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/.luna-container.json';

import type { AttachmentsConfig } from './attachment-digest.js';
import type { ContextOptimizationConfig, TopicsConfig } from './providers/openai/context.js';

export interface RunnerAppleDefaults {
  defaultCalendar?: string | null;
  defaultRemindersList?: string | null;
}

/**
 * Endpoints for the runner's own background model work. Resolved host-side from
 * `models.memory`, falling back per job — see `resolveMemoryModelConfig`.
 *
 * `chatModel` runs topic classification and attachment digests (so it may need
 * vision) and falls back to the main chat model when unset. `summaryModel` runs
 * episode summarization and falls back to the memory endpoint's model, which is
 * typically a cheap local server.
 */
export interface RunnerMemoryModels {
  baseUrl?: string;
  apiKey?: string;
  chatModel?: string;
  summaryBaseUrl?: string;
  summaryApiKey?: string;
  summaryModel?: string;
  /** Check memory once before each substantive user turn. Default true. */
  autoRecall?: boolean;
}

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  maxMessagesPerPrompt: number;
  context?: ContextOptimizationConfig;
  mcpServers: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      toolsAllow?: string[];
      toolsIgnore?: string[];
    }
  >;
  model?: string;
  effort?: string;
  /** Install-wide Apple defaults for session agenda / reminders injection. */
  apple?: RunnerAppleDefaults;
  /** Cheap endpoint for episode topic detection + summarization. */
  memory?: RunnerMemoryModels;
}

let cached: RunnerConfig | undefined;
const configuredString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
export function loadConfig(): RunnerConfig {
  if (cached) return cached;
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
  } catch {
    console.error('[config] Host configuration unavailable; using runner defaults');
  }
  const maximum = Number(input.maxMessagesPerPrompt);
  cached = {
    provider: configuredString(input.provider) ?? 'openai',
    assistantName: configuredString(input.assistantName) ?? '',
    maxMessagesPerPrompt: Number.isInteger(maximum) && maximum > 0 ? maximum : 10,
    model: configuredString(input.model),
    effort: configuredString(input.effort),
    mcpServers:
      input.mcpServers && typeof input.mcpServers === 'object' && !Array.isArray(input.mcpServers)
        ? (input.mcpServers as RunnerConfig['mcpServers'])
        : {},
    context: normalizeContextConfig(input.context),
    apple: normalizeAppleConfig(input.apple),
    memory: normalizeMemoryConfig(input.memory),
  };
  return cached;
}

function normalizeAppleConfig(raw: unknown): RunnerAppleDefaults | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: RunnerAppleDefaults = {};
  if ('defaultCalendar' in o) {
    out.defaultCalendar = typeof o.defaultCalendar === 'string' ? o.defaultCalendar : null;
  }
  if ('defaultRemindersList' in o) {
    out.defaultRemindersList = typeof o.defaultRemindersList === 'string' ? o.defaultRemindersList : null;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMemoryConfig(raw: unknown): RunnerMemoryModels | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: RunnerMemoryModels = {};
  if (typeof o.baseUrl === 'string' && o.baseUrl) out.baseUrl = o.baseUrl;
  if (typeof o.apiKey === 'string' && o.apiKey) out.apiKey = o.apiKey;
  if (typeof o.chatModel === 'string' && o.chatModel) out.chatModel = o.chatModel;
  if (typeof o.summaryBaseUrl === 'string' && o.summaryBaseUrl) out.summaryBaseUrl = o.summaryBaseUrl;
  if (typeof o.summaryApiKey === 'string' && o.summaryApiKey) out.summaryApiKey = o.summaryApiKey;
  if (typeof o.summaryModel === 'string' && o.summaryModel) out.summaryModel = o.summaryModel;
  if (typeof o.autoRecall === 'boolean') out.autoRecall = o.autoRecall;
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

function normalizeAttachmentsConfig(raw: unknown): AttachmentsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: AttachmentsConfig = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (o.deadlineMs !== undefined) out.deadlineMs = Number(o.deadlineMs);
  if (o.maxCharsPerAttachment !== undefined) out.maxCharsPerAttachment = Number(o.maxCharsPerAttachment);
  if (o.maxBlockChars !== undefined) out.maxBlockChars = Number(o.maxBlockChars);
  if (o.maxGistChars !== undefined) out.maxGistChars = Number(o.maxGistChars);
  if (o.maxPdfPages !== undefined) out.maxPdfPages = Number(o.maxPdfPages);
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
