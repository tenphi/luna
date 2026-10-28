import fs from 'fs';
import path from 'path';

import type { ContextOptimizationConfig } from './providers/openai/context.js';
import {
  compactHistory,
  inspectSessionPayload,
  resolveContextConfig,
} from './providers/openai/context.js';
import { LEARN_STATE_KEY } from './providers/openai/tools/learn-state.js';
import { resolveTopicsConfig } from './providers/openai/episodes/config.js';
import { relativeWhen } from './providers/openai/episodes/format.js';
import { currentEpisode, readEpisodes } from './providers/openai/episodes/ledger.js';
import { closeCurrentEpisode, isTrivialEpisode } from './providers/openai/episodes/turn.js';
import {
  loadHistory,
  loadSession,
  rewriteSession,
  sessionExists,
  sessionSize,
  setSessionsDirForTests,
} from './providers/openai/session-store.js';
import type { MessageInRow } from './db/messages-in.js';
import { clearContinuation, setContinuation } from './db/session-state.js';
import { getSessionClient, type UsageTotals } from './session/client.js';
import { parseSlashCommand } from './slash-command.js';

export const RUNNER_COMMANDS = new Set([
  '/clear',
  '/compact',
  '/context',
  '/usage',
  '/files',
  '/stop',
  '/learn',
  '/topics',
]);

const WORKSPACE = '/workspace';
const AGENT_DIR = path.join(WORKSPACE, 'agent');
const INBOX_DIR = path.join(WORKSPACE, 'inbox');
const OUTBOX_DIR = path.join(WORKSPACE, 'outbox');

const FILES_MAX_DEPTH = 3;
const FILES_MAX_ENTRIES = 50;

const EXCLUDED_DIR_NAMES = new Set(['.openai-sessions', 'node_modules', '.git']);
const EXCLUDED_FILE_SUFFIXES = ['.db', '.jsonl'];

export interface SessionCommandContext {
  providerName: string;
  continuation?: string;
  contextConfig?: ContextOptimizationConfig;
  /** Per-session eligibility for topic segmentation (off for groups/ephemeral). */
  episodesEnabled?: boolean;
}

/**
 * One outbound row a command wants written.
 *
 * Commands used to answer with a single string. Two of the memory commands cannot:
 * `/read` splits a long page across messages, and `/download` must send one file
 * per row because the Telegram adapter rejects a message carrying more than one
 * upload (and rejects it *inside* delivery, so the row would retry forever).
 */
export interface RunnerCommandMessage {
  text: string;
  /**
   * Verbatim delivery. Defaults to true: every command reply that existed before
   * the memory commands is line-oriented (topic lists, key/value dumps) and Rich
   * Markdown collapses single newlines. Only page renders opt into `false`.
   */
  plain?: boolean;
  /** Exactly one basename, already staged under `<workspace>/outbox/<id>/`. */
  files?: string[];
  /** Outbox id the handler staged `files` under — the row id must match the dir. */
  id?: string;
}

export type RunnerCommandResult = string | RunnerCommandMessage[];

/** Runaway guard. No handler intends to emit this many rows. */
const MAX_COMMAND_MESSAGES = 24;

/** A bare string is one plain message — the shape every command had before files. */
export function runnerCommandMessages(result: RunnerCommandResult): RunnerCommandMessage[] {
  if (typeof result === 'string') return [{ text: result, plain: true }];
  return result
    .filter((msg) => msg.text.length > 0 || (msg.files?.length ?? 0) > 0)
    .slice(0, MAX_COMMAND_MESSAGES);
}

/**
 * Serialize one reply into a `messages_out.content` payload. Emitting `plain`
 * only when it is true keeps the legacy shape byte-identical.
 */
export function runnerOutboundContent(out: RunnerCommandMessage): string {
  const content: Record<string, unknown> = { text: out.text };
  if (out.plain !== false) content.plain = true;
  if (out.files && out.files.length > 0) content.files = out.files;
  return JSON.stringify(content);
}

function messageText(msg: MessageInRow): string {
  try {
    const parsed = JSON.parse(msg.content) as { text?: string };
    return (parsed.text ?? '').trim();
  } catch {
    return msg.content.trim();
  }
}

export function parseRunnerCommand(msg: MessageInRow): string | null {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return null;
  const command = parseSlashCommand(messageText(msg));
  if (!command || !RUNNER_COMMANDS.has(command)) return null;
  return command;
}

function unsupportedProvider(providerName: string): string {
  return `/${providerName} provider does not support this command.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function episodesActive(ctx: SessionCommandContext): boolean {
  return (
    ctx.providerName === 'openai' &&
    (ctx.episodesEnabled ?? false) &&
    resolveTopicsConfig(ctx.contextConfig?.topics).enabled
  );
}

/**
 * With topics on, `/clear` archives instead of wiping: the current episode is
 * closed (summary + touched pages snapshotted, background summarizer queued)
 * and an unnamed one opens, named by the next message.
 *
 * Usage counters are not reset: they live in the host's day-bucketed ledger,
 * and the per-topic view restarts on its own with the new episode.
 */
async function handleClear(ctx: SessionCommandContext): Promise<string> {
  if (episodesActive(ctx)) {
    const history = ctx.continuation ? loadHistory(ctx.continuation) ?? [] : [];
    const { closed, opened } = await closeCurrentEpisode(history);
    await setContinuation(ctx.providerName, opened.historyId);
    if (closed && !isTrivialEpisode(closed)) {
      return `Starting fresh. Archived ${closed.emoji} ${closed.title} — ask me to get back to it any time.`;
    }
    return 'Starting fresh.';
  }

  await clearContinuation(ctx.providerName);
  return 'Session cleared.';
}

/** List the session's recent topics. Resuming is a sentence, not a command. */
async function handleTopics(ctx: SessionCommandContext): Promise<string> {
  if (ctx.providerName !== 'openai') return unsupportedProvider(ctx.providerName);
  if (!episodesActive(ctx)) return 'Topic tracking is off for this conversation.';

  const episodes = await readEpisodes();
  if (episodes.length === 0) return 'No topics yet.';

  const lines = episodes
    .slice()
    .reverse()
    .map((episode, index) => {
      const when = index === 0 ? 'current' : relativeWhen(episode.lastActiveAt);
      const page = episode.conversationPage ? ` · ${episode.conversationPage}` : '';
      return `${episode.emoji} ${episode.title} — ${when}${page}`;
    });
  return lines.join('\n');
}

function handleCompact(ctx: SessionCommandContext): string {
  if (ctx.providerName !== 'openai') return unsupportedProvider(ctx.providerName);
  const sessionId = ctx.continuation;
  if (!sessionId || !sessionExists(sessionId)) return 'No active session to compact.';

  const payload = loadSession(sessionId);
  if (!payload || payload.messages.length === 0) return 'No active session to compact.';

  const beforeBytes = sessionSize(sessionId) ?? 0;
  const compactConfig: ContextOptimizationConfig = {
    ...resolveContextConfig(ctx.contextConfig),
    summarization: 'deterministic',
  };
  const result = compactHistory(payload.messages, compactConfig, { force: true });
  if (!result.compacted) return 'Nothing to compact — session is already minimal.';

  rewriteSession(sessionId, result.history);
  const afterBytes = sessionSize(sessionId) ?? 0;
  return `Context compacted (${result.droppedMessages} message(s) dropped, ${formatBytes(beforeBytes)} → ${formatBytes(afterBytes)}).`;
}

function handleContext(ctx: SessionCommandContext): string {
  if (ctx.providerName !== 'openai') return unsupportedProvider(ctx.providerName);
  const sessionId = ctx.continuation;
  if (!sessionId || !sessionExists(sessionId)) return 'No active session.';

  const payload = loadSession(sessionId);
  if (!payload) return 'No active session.';

  const fileBytes = sessionSize(sessionId) ?? 0;
  const stats = inspectSessionPayload(payload);
  const lines = [
    `session: ${sessionId}`,
    `file_bytes: ${fileBytes}`,
    `messages: ${stats.history.messages}`,
    `approx_tokens: ${stats.history.approxTokens}`,
    `roles: ${JSON.stringify(stats.history.byRole)}`,
    `tool_result_chars: ${stats.history.toolResultChars}`,
    `largest_tool_result_chars: ${stats.history.largestToolResultChars}`,
    `has_summary_message: ${stats.hasSummaryMessage}`,
  ];
  if (stats.updatedAt) lines.push(`updated_at: ${stats.updatedAt}`);
  if (stats.lastCompactionAt) lines.push(`last_compaction_at: ${stats.lastCompactionAt}`);
  return lines.join('\n');
}

/** `128.4k` / `2.1M` — token counts are read for magnitude, not precision. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Cache hit rate over the prompt tokens of turns that actually reported
 * `prompt_tokens_details`. Dividing by all prompt tokens would under-report
 * whenever the endpoint omits cache details for some completions.
 */
function cacheRate(totals: UsageTotals): string {
  if (totals.promptTokensCacheKnown <= 0) return 'cached n/a';
  return `cached ${Math.round((totals.cachedTokens / totals.promptTokensCacheKnown) * 100)}%`;
}

function usageStanza(label: string, totals: UsageTotals, suffix = ''): string[] {
  if (totals.turns === 0) return [`${label} — nothing yet${suffix}`];
  return [
    `${label} — ${totals.turns} turn${totals.turns === 1 ? '' : 's'}${suffix}`,
    `in ${formatTokens(totals.promptTokens)} · out ${formatTokens(totals.completionTokens)} · ${cacheRate(totals)}`,
  ];
}

/**
 * Token spend for the periods a human actually asks about. Today and this month
 * are install-wide (Telegram + CLI + `luna ask`); the topic line is this
 * session's current episode. No costs — the endpoint is arbitrary and Luna has
 * no price table.
 */
async function handleUsage(ctx: SessionCommandContext): Promise<string> {
  if (ctx.providerName !== 'openai') return unsupportedProvider(ctx.providerName);

  const episode = episodesActive(ctx) ? await currentEpisode() : null;
  const summary = await getSessionClient().getUsageSummary(episode?.id ?? null);

  if (summary.month.turns === 0 && summary.session.turns === 0) {
    return 'No usage recorded yet.';
  }

  const blocks: string[][] = [
    usageStanza('Today', summary.today),
    usageStanza('This month', summary.month),
  ];
  if (episode && summary.topic) {
    blocks.push(usageStanza('This topic', summary.topic, ` · ${episode.emoji} ${episode.title}`));
  } else {
    blocks.push(usageStanza('This session', summary.session));
  }

  const out = ['📊 Usage', ...blocks.map((lines) => lines.join('\n'))];
  if (summary.updatedAt) out.push(`Updated ${relativeWhen(summary.updatedAt)}`);
  return out.join('\n\n');
}

function shouldSkipEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (isDir && EXCLUDED_DIR_NAMES.has(name)) return true;
  if (!isDir && EXCLUDED_FILE_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return false;
}

function collectFiles(
  root: string,
  prefix: string,
  depth: number,
  out: string[],
): void {
  if (depth > FILES_MAX_DEPTH || out.length >= FILES_MAX_ENTRIES) return;
  if (!fs.existsSync(root)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= FILES_MAX_ENTRIES) break;
    if (shouldSkipEntry(entry.name, entry.isDirectory())) continue;

    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    out.push(rel);
    if (entry.isDirectory()) {
      collectFiles(path.join(root, entry.name), rel, depth + 1, out);
    }
  }
}

function handleFiles(): string {
  const paths: string[] = [];
  const roots: Array<{ dir: string; label: string }> = [
    { dir: INBOX_DIR, label: 'inbox' },
    { dir: OUTBOX_DIR, label: 'outbox' },
    { dir: AGENT_DIR, label: 'agent' },
  ];

  for (const { dir, label } of roots) {
    if (!fs.existsSync(dir)) continue;
    const before = paths.length;
    collectFiles(dir, label, 0, paths);
    if (paths.length === before && fs.existsSync(dir)) {
      try {
        const top = fs.readdirSync(dir);
        if (top.length === 0) continue;
      } catch {
        continue;
      }
    }
  }

  if (paths.length === 0) return 'No session files found.';
  const listed = paths.slice(0, FILES_MAX_ENTRIES);
  const suffix = paths.length > FILES_MAX_ENTRIES ? `\n… and ${paths.length - FILES_MAX_ENTRIES} more` : '';
  return listed.join('\n') + suffix;
}

function handleStop(): string {
  return 'Stopped.';
}

function parseLearnArg(text: string): 'on' | 'off' | 'toggle' {
  // Via commandArg so `/learn@lunabot on` turns learning on instead of toggling
  // it — the old `^\/learn\b` strip left `@lunabot on` behind.
  const arg = commandArg(text, '/learn').toLowerCase();
  if (!arg) return 'toggle';
  if (['on', 'enable', 'enabled', 'true', 'yes'].includes(arg)) return 'on';
  if (['off', 'disable', 'disabled', 'false', 'no'].includes(arg)) return 'off';
  return 'toggle';
}

/**
 * Toggle background memory learning for this session (`/learn [on|off]`).
 * Persists a `learn_enabled` flag in session_state; the host's post-turn digest
 * reads it before handing the turn to memory. Explicit inline memory edits by
 * the main agent are unaffected.
 */
async function handleLearn(msg: MessageInRow, _ctx: SessionCommandContext): Promise<string> {
  const client = getSessionClient();
  const requested = parseLearnArg(messageText(msg));

  let enabled: boolean;
  if (requested === 'toggle') {
    const current = await client.getSessionState(LEARN_STATE_KEY);
    // Default is ON, so an unset flag toggles to off.
    enabled = current === 'false' ? true : false;
  } else {
    enabled = requested === 'on';
  }

  await client.setSessionState(LEARN_STATE_KEY, enabled ? 'true' : 'false');
  return enabled
    ? '🧠 Learning is ON — I will quietly update my memory from our chats.'
    : '🧠 Learning is OFF — I will not auto-update memory (I can still remember things when you ask).';
}

// --- Knowledge-base commands ----------------------------------------------

/**
 * The text after the command token.
 *
 * `parseSlashCommand` deliberately returns only the token, so arguments are
 * recovered here — including the `@botname` suffix Telegram appends in groups.
 */
export function commandArg(text: string, command: string): string {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${escaped}(?:@[a-z0-9_]+)?`, 'i'), '').trim();
}


export async function executeRunnerCommand(
  command: string,
  ctx: SessionCommandContext,
  msg?: MessageInRow,
): Promise<RunnerCommandResult> {
  const arg = msg ? commandArg(messageText(msg), command) : '';
  switch (command) {
    case '/clear':
      return handleClear(ctx);
    case '/compact':
      return handleCompact(ctx);
    case '/context':
      return handleContext(ctx);
    case '/usage':
      return handleUsage(ctx);
    case '/files':
      return handleFiles();
    case '/stop':
      return handleStop();
    case '/learn':
      if (!msg) return 'Learn requires the inbound message.';
      return handleLearn(msg, ctx);
    case '/topics':
      return handleTopics(ctx);
    default:
      return `Unknown command: ${command}`;
  }
}

/** Test hook — re-export for session file redirection in tests. */
export { setSessionsDirForTests };
