/**
 * The `<recent-conversations>` block — the agent's view of its own recent past.
 *
 * Model-free by construction: closed episodes contribute the summary the
 * background summarizer (or the deterministic close) already wrote, and the
 * current episode contributes the memory pages it has touched, read straight
 * off the change journal. Spliced next to `<memory>` as an ephemeral system
 * addon, so it never accumulates in history.
 */
import {
  activeSegmentStartedAt,
  readEpisodes,
  touchedPagesSince,
  type Episode,
  type TouchedPage,
} from './ledger.js';
import { clipChars, relativeWhen } from './format.js';

/** Per-episode summary budget. Four of these ride on every substantive turn. */
const MAX_SUMMARY_CHARS = 240;

export const RECENT_CONVERSATIONS_TAG = 'recent-conversations';

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = clipChars(flat, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function renderTouchedPages(pages: TouchedPage[]): string {
  return `pages touched: ${pages.map((p) => `${p.action} ${p.slug}`).join(', ')}`;
}

function renderClosed(episode: Episode, now: Date): string {
  const parts = [`${episode.id} · ${episode.emoji} ${episode.title} — ${relativeWhen(episode.lastActiveAt, now)}.`];
  if (episode.summary) parts.push(truncate(episode.summary, MAX_SUMMARY_CHARS));
  if (episode.conversationPage) parts.push(`(${episode.conversationPage})`);
  return `- ${parts.join(' ')}`;
}

function renderCurrent(episode: Episode, pages: TouchedPage[]): string {
  const head = `now · ${episode.emoji} ${episode.title}`;
  return `- ${pages.length > 0 ? `${head} — ${renderTouchedPages(pages)}` : head}`;
}

/**
 * Most recent `injectCount` episodes, newest first. Returns null when there is
 * nothing worth saying — a session whose only episode is the one in progress
 * has no past to recall, and its pages are already in `<memory-structure>`.
 */
export async function buildRecentConversationsBlock(options?: {
  injectCount?: number;
  now?: Date;
}): Promise<string | null> {
  const injectCount = Math.max(0, options?.injectCount ?? 4);
  if (injectCount === 0) return null;

  const episodes = await readEpisodes();
  const current = episodes[episodes.length - 1];
  if (!current) return null;

  const touched = await touchedPagesSince(activeSegmentStartedAt(current));
  if (episodes.length === 1 && touched.length === 0) return null;

  const now = options?.now ?? new Date();
  const lines = [renderCurrent(current, touched)];
  for (const episode of episodes.slice(-injectCount, -1).reverse()) {
    lines.push(renderClosed(episode, now));
  }

  return `<${RECENT_CONVERSATIONS_TAG}>\n${lines.join('\n')}\n</${RECENT_CONVERSATIONS_TAG}>`;
}
