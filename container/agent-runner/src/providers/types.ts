import type { AttachmentEvidence } from '../attachment-digest.js';
import type { ReplyEvidence } from '../formatter.js';
import type { ImageAttachment } from '../image-attachments.js';
import type { ContextOptimizationConfig } from './openai/context.js';
export type McpServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  toolsAllow?: string[];
  toolsIgnore?: string[];
};
export type ProviderOptions = {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  model?: string;
  /** Configured effort may be adaptive; selected request effort is reported as an event. */
  effort?: string;
  context?: ContextOptimizationConfig;
  apple?: { defaultCalendar?: string | null; defaultRemindersList?: string | null };
  memory?: { autoRecall?: boolean };
};
export type QueryInput = {
  prompt: string;
  cwd: string;
  /** Raw text and source evidence feed the bounded topic and recall decisions. */
  topicText?: string;
  images?: ImageAttachment[];
  attachments?: AttachmentEvidence;
  replyTo?: ReplyEvidence;
  continuation?: string;
  taskRun?: { seriesId: string; runId: string; scheduledFor: string };
  systemContext?: { instructions?: string };
  senderIsPrivileged?: boolean;
  hotMemorySlug?: string | null;
  episodesEnabled?: boolean;
};
export type AgentQuery = {
  events: AsyncIterable<ProviderEvent>;
  end(): void;
  abort(): void;
  push(
    message: string,
    images?: ImageAttachment[],
    topicText?: string,
    attachments?: AttachmentEvidence,
    replyTo?: ReplyEvidence,
  ): void;
};
export type AgentProvider = {
  query(input: QueryInput): AgentQuery;
  isSessionInvalid(error: unknown): boolean;
  maybeRotateContinuation?(continuation: string, cwd: string): Promise<string | null> | string | null;
  ensureToolBridge?(): Promise<{
    hasConnectedServer(name: string): boolean;
    callRaw(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
  } | null>;
};
export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; index?: number }
  | { type: 'tool_compose'; index: number; name: string }
  | { type: 'phase'; phase: 'thinking' | 'generating'; text?: string }
  | { type: 'progress'; message: string }
  /** Interim prose does not complete a turn; result does. */
  | { type: 'interim'; text: string }
  | { type: 'result'; text: string | null }
  /** Activity keeps the runtime's idle deadline accurate during tool calls. */
  | { type: 'activity' }
  | { type: 'effort'; effort: string }
  | {
      type: 'topic';
      action: 'new' | 'resumed';
      episodeId: string;
      title: string;
      emoji: string;
      lastActiveAt?: string;
      first: boolean;
      closedTrivial: boolean;
    };
