/**
 * Episode summarizer — one non-streaming, tool-less call per closed episode,
 * drained in a background hook after the turn so it adds zero latency to the
 * user's reply.
 *
 * The writing rule is the load-bearing part: every sentence is attributed to a
 * participant ("Ada asked to be reminded…", "we settled on…") rather than
 * asserting a bare world fact. That keeps these summaries from competing with
 * the canonical pages — a dated, past-tense account of an exchange stays true
 * after the plan changes, where "5 nights in Harbourtown" would rot into a rival
 * current claim. Durable world facts belong to memory's own post-turn pass, on
 * `travel/`, `people/`, and `projects/` pages.
 */
import { loadConfig } from '../../../config.js';
import {
  compactHistory,
  compactIfOverBudget,
  findRecentTailStart,
  resolveContextConfig,
  type CompactResult,
  type ContextOptimizationConfig,
} from '../context.js';
import { loadHistory } from '../session-store.js';
import type { OpenAITool } from '../tools/builtin.js';
import type { ChatMessage, ToolCall } from '../types.js';
import { resolveTopicsConfig, type ResolvedTopicsConfig } from './config.js';
import { countUserTurns, episodeTranscript, sanitizeEmoji, sanitizeTitle } from './format.js';
import { readEpisodes, updateEpisode, type Episode } from './ledger.js';
import {
  memoryChat,
  parseJsonObject,
  type MemoryChatMessage,
  type MemoryChatOptions,
} from './memory-model.js';
import { needsSummary } from './turn.js';

/** Transcript budget handed to the summarizer. */
const TRANSCRIPT_CHARS = 8_000;
const TRANSCRIPT_CHARS_PER_LINE = 400;

/**
 * Episodes summarized per background pass.
 *
 * The drain is sequential and shares a container that can be torn down at any
 * moment, so an unbounded batch makes no progress at all once a backlog forms:
 * it re-attempts the whole list every pass and gets killed at the same place.
 * A cap turns that into steady progress — the rest are picked up next turn.
 */
const MAX_PER_DRAIN = 5;

export interface EpisodeSummary {
  title: string;
  emoji: string;
  summary: string;
  openThreads: string[];
}

/** Just enough of the OpenAI provider to run one completion on the main model. */
export interface SummaryHost {
  completeTurn(
    messages: ChatMessage[],
    tools: OpenAITool[],
    signal: AbortSignal,
  ): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

/**
 * Whether a provider can run a main-model completion.
 *
 * Structural rather than an `instanceof`, because the caller holds an
 * `AgentProvider` and only the OpenAI one satisfies this — the poll loop must be
 * able to ask without importing the provider it is asking about. This used to be
 * borrowed from the memory agent's own, wider guard, which also demanded a tool
 * dispatcher and a tool list that summaries never needed; when that component was
 * removed the narrower question moved here, beside the interface it answers.
 */
export function isSummaryHost(value: unknown): value is SummaryHost {
  return !!value && typeof (value as Partial<SummaryHost>).completeTurn === 'function';
}

export type SummaryChatFn = (
  messages: MemoryChatMessage[],
  opts?: MemoryChatOptions,
) => Promise<string | null>;

export interface SummarizeOptions {
  summaryModel?: 'memory' | 'main';
  /** Required for `summaryModel: 'main'`. */
  host?: SummaryHost | null;
  /** Injectable memory-model call, for tests. */
  chat?: SummaryChatFn;
  signal?: AbortSignal;
}

function log(msg: string): void {
  console.error(`[episodes] ${msg}`);
}

const SUMMARY_SYSTEM = `You summarize one segment of a conversation between a user and their assistant. The summary is for the assistant's own long-term records, written from the assistant's point of view ("I").

Reply with JSON only:
{"title":"<3-6 word topic name>","emoji":"<single emoji for the topic>","summary":"<2-4 sentences>","openThreads":["<unresolved item>"]}

Write the title, the summary, and every open thread in ENGLISH, whatever language the conversation was in — this record is for the assistant, not for the user. Keep names, place names, and short verbatim quotes as they were spelled; everything around them is English prose.

Rules for the summary:
- Every sentence must say what someone said, asked, or decided: "Ada asked me to remind her about the permit renewal on 29 July", "we settled on five nights in Harbourtown", "I found three flight options". Never assert a bare fact about the world.
- Past tense, with dates kept explicit. Write "on 25 July we settled on five nights in Harbourtown", not "five nights in Harbourtown".
- Names, dates, numbers and decisions are welcome — they just have to describe the exchange.
- No advice, no speculation, no commentary about summarizing.
- openThreads: up to 3 short items still unresolved, or [] when nothing is pending.`;

function renderTranscript(history: ChatMessage[]): string {
  return episodeTranscript(history, TRANSCRIPT_CHARS, TRANSCRIPT_CHARS_PER_LINE);
}

async function complete(
  messages: MemoryChatMessage[],
  opts: SummarizeOptions,
): Promise<string | null> {
  if (opts.summaryModel === 'main' && opts.host) {
    // The main model has no JSON mode guarantee either way; the prompt asks for
    // JSON and `parseJsonObject` tolerates fences and stray prose.
    const signal = opts.signal ?? new AbortController().signal;
    const res = await opts.host.completeTurn(messages as ChatMessage[], [], signal);
    return res.text || null;
  }
  // Roomy enough that an endpoint which rejects `reasoning_effort` (and so
  // still thinks) can finish the JSON rather than returning empty content.
  // `role: 'summary'` keeps this on the cheap endpoint when `models.memory` is
  // unset — summaries are bulk, low-stakes work, unlike classification.
  return (opts.chat ?? memoryChat)(messages, {
    json: true,
    maxTokens: 1200,
    temperature: 0.2,
    role: 'summary',
  });
}

/** Summarize a transcript. Returns null when the model is unavailable or unusable. */
export async function summarizeTranscript(
  history: ChatMessage[],
  opts: SummarizeOptions = {},
): Promise<EpisodeSummary | null> {
  if (history.length === 0) return null;
  const transcript = renderTranscript(history);
  if (!transcript.trim()) return null;

  let raw: string | null;
  try {
    raw = await complete(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: transcript },
      ],
      opts,
    );
  } catch (err) {
    log(`Summarizer call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const parsed = parseJsonObject<{
    title?: unknown;
    emoji?: unknown;
    summary?: unknown;
    openThreads?: unknown;
  }>(raw);
  if (!parsed) {
    log(`Summarizer returned unusable output: ${(raw ?? '(empty)').slice(0, 300)}`);
    return null;
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) return null;

  return {
    title: sanitizeTitle(parsed.title, ''),
    emoji: sanitizeEmoji(parsed.emoji, ''),
    summary,
    openThreads: Array.isArray(parsed.openThreads)
      ? parsed.openThreads.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 3)
      : [],
  };
}

/** Summary text as stored in the ledger: prose plus any open threads. */
export function formatSummaryBody(summary: EpisodeSummary): string {
  if (summary.openThreads.length === 0) return summary.summary;
  return `${summary.summary}\nOpen: ${summary.openThreads.join('; ')}`;
}

export interface DrainEpisodesOptions extends SummarizeOptions {
  topics?: ResolvedTopicsConfig;
  /** Called for each freshly summarized episode — the `conversations/` mirror. */
  onSummarized?: (episode: Episode, summary: EpisodeSummary) => Promise<unknown>;
}

/**
 * Summarize every closed episode still waiting for one. Trivial episodes — under
 * two exchanges and no memory writes — keep their classifier-given title and
 * nothing else: a week of "what's the weather?" pages would only dilute memory.
 */
export async function drainEpisodeSummaries(opts: DrainEpisodesOptions = {}): Promise<number> {
  const topics = opts.topics ?? resolveTopicsConfig(loadConfig().context?.topics);
  if (!topics.enabled) return 0;

  const episodes = await readEpisodes();
  // The tail entry is the live episode — it gets summarized when it closes.
  const pending = episodes.slice(0, -1).filter(needsSummary);
  if (pending.length === 0) return 0;

  // Newest first: a backlog is worked off from the end the user is most likely
  // to ask about, and `<recent-conversations>` only shows the last few anyway.
  const closed = pending.slice(-MAX_PER_DRAIN).reverse();
  if (pending.length > closed.length) {
    log(`${pending.length} episodes pending a summary — taking ${closed.length} this pass`);
  }

  let done = 0;
  for (const episode of closed) {
    const history = loadHistory(episode.historyId);
    if (!history || history.length === 0) {
      // Nothing left to read (rotated or pruned) — don't retry forever.
      await updateEpisode(episode.id, { summarizedAt: new Date().toISOString() });
      continue;
    }

    const summary = await summarizeTranscript(history, {
      summaryModel: topics.summaryModel,
      host: opts.host,
      chat: opts.chat,
      signal: opts.signal,
    });
    if (!summary) {
      // Leave the provisional summary in place and try again next drain.
      log(`Summary unavailable for ${episode.id} — keeping provisional text`);
      continue;
    }

    const updated = await updateEpisode(episode.id, {
      title: summary.title || episode.title,
      emoji: summary.emoji || episode.emoji,
      summary: formatSummaryBody(summary),
      exchanges: episode.exchanges ?? countUserTurns(history),
      summarizedAt: new Date().toISOString(),
    });
    done++;
    log(`Summarized ${episode.id} (${updated?.title ?? episode.title})`);

    // The mirror is a separate concern and a separate failure: a summary that
    // reached the ledger stays there even when memory is unreachable, and the
    // next drain does not re-run it (the `summarizedAt` stamp is already set).
    if (opts.onSummarized && updated) {
      try {
        await opts.onSummarized(updated, summary);
      } catch (err) {
        log(`Episode mirror failed for ${episode.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return done;
}

/**
 * Compaction with a real model summary — the implementation behind
 * `summarization: 'model'`. `compactHistory` stays synchronous and takes the
 * finished prose through its existing `externalSummary` hook; when the model is
 * unavailable the deterministic result stands.
 */
export async function compactIfOverBudgetWithSummary(
  history: ChatMessage[],
  config: ContextOptimizationConfig,
  opts: { byteSize?: number; byteCap?: number } & SummarizeOptions,
): Promise<CompactResult> {
  const deterministic = compactIfOverBudget(history, config, opts);
  const resolved = resolveContextConfig(config);
  if (resolved.summarization !== 'model' || !deterministic.compacted) return deterministic;

  const older = history.slice(0, findRecentTailStart(history, resolved.keepRecentTurns));
  const summary = await summarizeTranscript(older, opts);
  if (!summary) return deterministic;

  const modelled = compactHistory(history, config, {
    force: true,
    externalSummary: formatSummaryBody(summary),
  });
  return modelled.compacted ? modelled : deterministic;
}
