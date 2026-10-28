/**
 * `read_topic` — look at a parked topic's conversation without moving to it.
 *
 * This is what makes aggressive topic switching safe. The automatic decision is
 * biased by how expensive its two errors are, and until this tool existed they
 * were wildly asymmetric: a wrong `continue` merges two subjects quietly, while
 * a wrong `new` stranded the agent with an empty history and no way back except
 * `resume_topic`, which *moves* the conversation. Reading is not moving — the
 * ledger is untouched, the current topic keeps the turn, and the transcript
 * arrives as an ordinary tool result. That turns a mis-switch into one extra
 * tool call, which is what lets the gate and the classifier stop hedging.
 *
 * Everything here is model-free: `episodeTranscript` already drops injected
 * blocks and tool traffic, so what comes back is what the two of them said and
 * nothing that was staged around it.
 */
import { loadHistory } from '../session-store.js';
import type { OpenAITool } from '../tools/builtin.js';
import type { ChatMessage } from '../types.js';
import { countUserTurns, episodeTranscript, relativeWhen } from './format.js';
import { readEpisodes, type Episode } from './ledger.js';

export const READ_TOPIC = 'read_topic';

/**
 * Transcript budget. The median episode transcript is ~1.2k chars and the 90th
 * percentile ~4.8k, so this returns most topics whole. It also matches the
 * old-tool-result cap in `context.ts`, so the result sitting in history for the
 * rest of the episode never enlarges the region compaction has to fold away.
 */
const DEFAULT_READ_CHARS = 4_000;
const MAX_READ_CHARS = 12_000;
/**
 * Roomier per line than the summarizer's 400. A summary only needs the gist of
 * each turn; someone re-reading a topic needs the answer that was actually
 * given, and at 400 the longest episode in a real ledger lost half its content
 * to per-line clipping alone.
 */
const READ_CHARS_PER_LINE = 600;

export const readTopicSchema: OpenAITool = {
  type: 'function',
  function: {
    name: READ_TOPIC,
    description:
      'Read an earlier topic\'s conversation without leaving the current one. Use it when the user' +
      ' refers to something the current topic has no history of, or when a topic looks like it was' +
      ' split off by mistake — read the parked topic and keep answering here. Read-only: nothing' +
      ' moves, unlike resume_topic. Call with no arguments to list every topic first.',
    parameters: {
      type: 'object',
      properties: {
        episode_id: {
          type: 'string',
          description: 'Topic id from <recent-conversations>, e.g. "ep_6c11". Omit to list every topic.',
        },
        chars: {
          type: 'number',
          description: `Transcript budget, default ${DEFAULT_READ_CHARS}, max ${MAX_READ_CHARS}. Raise it when the tail is not enough.`,
        },
      },
    },
  },
};

/** One ledger entry as a discovery line: enough to pick an id, no transcript. */
function listLine(episode: Episode, current: boolean, now: Date): string {
  const parts = [`${episode.id} · ${episode.emoji} ${episode.title}`];
  parts.push(current ? 'current' : relativeWhen(episode.lastActiveAt, now));
  if (episode.exchanges !== undefined) parts.push(`${episode.exchanges} exchanges`);
  return `- ${parts.join(' — ')}`;
}

/** Every topic in the ledger, newest first. Shared with `resume_topic`'s error path. */
export function renderTopicList(episodes: Episode[], now: Date = new Date()): string {
  if (episodes.length === 0) return 'No topics yet.';
  const currentId = episodes[episodes.length - 1]?.id;
  return episodes
    .slice()
    .reverse()
    .map((episode) => listLine(episode, episode.id === currentId, now))
    .join('\n');
}

function clampChars(raw: unknown): number {
  const asked = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_READ_CHARS;
  return Math.min(MAX_READ_CHARS, Math.max(500, asked));
}

/**
 * Header plus transcript. The header carries the whole-episode picture (the
 * stored summary, which may still be the deterministic provisional one) and the
 * body carries the tail in full detail — between them a clipped read still says
 * what the topic was about, without a second model call.
 */
export function renderTopicRead(
  episode: Episode,
  history: ChatMessage[],
  options: { chars?: number; current?: boolean; now?: Date } = {},
): string {
  const now = options.now ?? new Date();
  const chars = options.chars ?? DEFAULT_READ_CHARS;

  const lines = [
    `${episode.emoji} ${episode.title} · ${episode.id}`,
    `Started ${relativeWhen(episode.startedAt, now)}, last active ${relativeWhen(episode.lastActiveAt, now)}` +
      ` · ${episode.exchanges ?? countUserTurns(history)} exchanges`,
  ];
  if (options.current) {
    lines.push('This is the current topic; its recent turns are already in your context.');
  }
  if (episode.slugs.length > 0) lines.push(`Pages touched: ${episode.slugs.join(', ')}`);
  if (episode.summary) lines.push(`Summary: ${episode.summary.replace(/\s+/g, ' ').trim()}`);
  if (episode.conversationPage) lines.push(`Full record: ${episode.conversationPage}`);

  if (history.length === 0) {
    lines.push(
      '',
      'The transcript is no longer on disk — the ledger has rolled past it.' +
        (episode.conversationPage
          ? ` Read ${episode.conversationPage} with get_memory_page for the full record.`
          : ''),
    );
    return lines.join('\n');
  }

  const full = episodeTranscript(history, Number.MAX_SAFE_INTEGER, READ_CHARS_PER_LINE);
  if (!full.trim()) {
    lines.push('', 'Nothing was said in this topic.');
    return lines.join('\n');
  }

  const clipped = full.length > chars ? episodeTranscript(history, chars, READ_CHARS_PER_LINE) : full;
  lines.push(
    '',
    full.length > chars
      ? `--- last ${clipped.length} of ${full.length} characters (raise "chars" for more) ---`
      : '--- full transcript ---',
    clipped,
  );
  return lines.join('\n');
}

export async function callReadTopic(args: Record<string, unknown>): Promise<string> {
  const episodes = await readEpisodes();
  const now = new Date();
  const episodeId = typeof args.episode_id === 'string' ? args.episode_id.trim() : '';

  if (!episodeId) return renderTopicList(episodes, now);

  const target = episodes.find((e) => e.id === episodeId);
  if (!target) {
    const known = renderTopicList(episodes, now);
    return `No topic with id "${episodeId}".\n\nKnown topics:\n${known}`;
  }

  return renderTopicRead(target, loadHistory(target.historyId) ?? [], {
    chars: clampChars(args.chars),
    current: target.id === episodes[episodes.length - 1]?.id,
    now,
  });
}
