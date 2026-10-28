/**
 * What a `conversations/<date>-<slug>` page is called and what it says.
 *
 * Split from the write path on purpose, and imported by both sides: this module
 * has no runtime imports at all, so the host can render exactly the page the
 * container would — a one-off backfill and the live mirror agreeing by
 * construction rather than by two copies of the same 30 lines staying in step.
 */
import type { Episode } from './ledger.js';
import type { EpisodeSummary } from './summarize.js';

/** Page slugs the episode summarizer owns. */
export const CONVERSATION_PREFIX = 'conversations/';

function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    // Drop the combining marks NFKD just split off, before the sweep below turns
    // them into separators: `Blåvik` decomposes to `Bla` + ◌̊ + `vik`, and a mark
    // treated as punctuation makes that `bla-vik`.
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'conversation';
}

function day(episode: Episode): string {
  const date = new Date(episode.startedAt);
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 10);
}

export function conversationSlug(episode: Episode): string {
  return `${CONVERSATION_PREFIX}${day(episode)}-${slugifyTitle(episode.title)}`;
}

/**
 * The page body, frontmatter included.
 *
 * The block is not decoration: a leading `---` fence is the **only** way this
 * boundary lets a caller set title, type and tags — `memory_write` takes a slug
 * and a body and nothing else. A partial block drops the keys it omits, so
 * everything the page should declare is stated here, every time.
 */
export function buildConversationPage(episode: Episode, summary: EpisodeSummary): string {
  const date = day(episode);
  const lines = [
    '---',
    // Quoted: a topic title is model-written and may hold a colon or a quote,
    // either of which turns the declaration into something else.
    `title: ${JSON.stringify(episode.title)}`,
    'type: conversation',
    'tags: [conversation]',
    `date: ${date}`,
    '---',
    '',
    `# ${episode.emoji} ${episode.title}`.trim(),
    '',
    `*Conversation on ${date}.*`,
    '',
    summary.summary,
  ];

  if (summary.openThreads.length > 0) {
    lines.push('', '## Open threads', ...summary.openThreads.map((t) => `- ${t}`));
  }
  if (episode.slugs.length > 0) {
    lines.push('', '## Pages touched', ...episode.slugs.map((slug) => `- [[${slug}]]`));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * A provisional summary is the transcript itself, one `role: text` line each.
 *
 * It carries the `summarizedAt` stamp in one case — an episode whose history was
 * already gone when the drain reached it, which the drain stamps so it stops
 * retrying a transcript it can no longer read. That is not a record worth a page:
 * `conversations/` holds attributed prose, not a raw exchange dump.
 */
function looksProvisional(body: string): boolean {
  return /^(?:user|assistant): /m.test(body);
}

/**
 * Read a stored summary back into its parts — prose plus the `Open:` line the
 * ledger flattens open threads onto. Null when there is nothing worth a page,
 * which is what makes this the eligibility test both callers share.
 */
export function summaryFromLedger(episode: Episode): EpisodeSummary | null {
  const body = episode.summary?.trim();
  if (!body || looksProvisional(body)) return null;
  const match = /\nOpen:\s*(.+)$/.exec(body);
  return {
    title: episode.title,
    emoji: episode.emoji,
    summary: match ? body.slice(0, match.index).trim() : body,
    openThreads: match
      ? match[1]
          .split(';')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 3)
      : [],
  };
}
