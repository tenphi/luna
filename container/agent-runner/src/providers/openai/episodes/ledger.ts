/**
 * Episode ledger — the per-session list of conversation topics.
 *
 * A session no longer keeps one history file forever. It keeps a bounded,
 * recency-ordered list of *episodes*, each pointing at its own history file
 * under `.openai-sessions/`. The tail entry is always the current episode, so
 * a resume re-appends its entry rather than flipping a status field.
 *
 * The ledger lives in host-owned `session_state` as a single JSON row reached
 * over the Session API, so it survives container restarts. The poll loop is
 * the only writer, so read-modify-write needs no locking.
 */
import { getSessionClient } from '../../../session/client.js';
import { deleteSession } from '../session-store.js';
import { readMemoryChanges, type MemoryChangeAction } from '../tools/memory-mutations.js';

export const EPISODES_STATE_KEY = 'episodes';

/**
 * Ledger cap. Older episodes drop off the end; the summary is what survives.
 *
 * Sized in days of reach, not entries: trimming deletes the history file, so
 * this is exactly how far back `read_topic` and `<recent-conversations>` can
 * see. Thirty entries was five days of the old, reluctant segmentation; once
 * topics split on subject rather than on an explicit cue it is closer to two.
 * Sixty is ~30 KB of JSON, re-serialized on every continue, which is the reason
 * not to go further.
 */
export const MAX_EPISODES = 60;

/** Cap on the touched-page list rendered for a single episode. */
const MAX_TOUCHED_PAGES = 10;

export interface Episode {
  id: string;
  title: string;
  emoji: string;
  /** `.openai-sessions/<historyId>.json` holding this episode's messages. */
  historyId: string;
  startedAt: string;
  lastActiveAt: string;
  /** Start of the current active segment; absent while the episode is parked. */
  activeSince?: string;
  /** Provisional at close, replaced by the background summarizer. */
  summary: string | null;
  /** Memory pages touched during the episode, snapshotted when it closes. */
  slugs: string[];
  /** `conversations/<date>-<slug>` mirror, once written. */
  conversationPage?: string;
  /** User turns, counted at close — drives the substance threshold. */
  exchanges?: number;
  /** Set once the background summarizer has processed this close. */
  summarizedAt?: string;
}

export interface TouchedPage {
  slug: string;
  action: MemoryChangeAction;
}

export function newEpisodeId(): string {
  return `ep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The row is external JSON — verify the fields we index by before trusting it. */
function isEpisode(value: unknown): value is Episode {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<Episode>;
  return typeof e.id === 'string' && typeof e.historyId === 'string';
}

export async function readEpisodes(): Promise<Episode[]> {
  try {
    const raw = await getSessionClient().getSessionState(EPISODES_STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEpisode) : [];
  } catch {
    return [];
  }
}

/**
 * Persist the ledger, trimming to `MAX_EPISODES`. History files belonging to
 * trimmed episodes are deleted here — that is the entire retention policy, so
 * a file can never outlive the entry that points at it.
 */
export async function writeEpisodes(episodes: Episode[]): Promise<void> {
  const bounded = episodes.slice(-MAX_EPISODES);
  const kept = new Set(bounded.map((e) => e.historyId));
  for (const dropped of episodes.slice(0, episodes.length - bounded.length)) {
    if (!kept.has(dropped.historyId)) deleteSession(dropped.historyId);
  }
  await getSessionClient().setSessionState(EPISODES_STATE_KEY, JSON.stringify(bounded));
}

/** The current episode is the tail entry, or null on a fresh session. */
export async function currentEpisode(): Promise<Episode | null> {
  const episodes = await readEpisodes();
  return episodes.length > 0 ? (episodes[episodes.length - 1] ?? null) : null;
}

export async function appendEpisode(fields: {
  title: string;
  emoji: string;
  historyId: string;
  /** Adoption of pre-episode history: when that history was really last active. */
  lastActiveAt?: string;
}): Promise<Episode> {
  const now = new Date().toISOString();
  const episode: Episode = {
    id: newEpisodeId(),
    title: fields.title,
    emoji: fields.emoji,
    historyId: fields.historyId,
    startedAt: now,
    lastActiveAt: fields.lastActiveAt ?? now,
    activeSince: now,
    summary: null,
    slugs: [],
  };
  const episodes = await readEpisodes();
  episodes.push(episode);
  await writeEpisodes(episodes);
  return episode;
}

export async function updateEpisode(
  id: string,
  patch: Partial<Omit<Episode, 'id'>>,
): Promise<Episode | null> {
  const episodes = await readEpisodes();
  const episode = episodes.find((e) => e.id === id);
  if (!episode) return null;
  Object.assign(episode, patch);
  await writeEpisodes(episodes);
  return episode;
}

/** Mark the current episode as still active (called on every `continue`). */
export async function touchEpisode(id: string, now = new Date()): Promise<void> {
  const episodes = await readEpisodes();
  const episode = episodes.find((e) => e.id === id);
  if (!episode) return;
  // Ledgers written before activeSince existed need a safe boundary before we
  // overwrite lastActiveAt. The previous activity stamp is the narrowest one
  // available; using startedAt would sweep in other topics after a resume.
  episode.activeSince ??= episode.lastActiveAt ?? episode.startedAt;
  episode.lastActiveAt = now.toISOString();
  await writeEpisodes(episodes);
}

/** Reopen an episode by moving it to the tail, making it current again. */
export async function resumeEpisode(id: string, now = new Date()): Promise<Episode | null> {
  const episodes = await readEpisodes();
  const index = episodes.findIndex((e) => e.id === id);
  if (index === -1) return null;
  const [episode] = episodes.splice(index, 1);
  if (!episode) return null;
  const resumedAt = now.toISOString();
  episode.lastActiveAt = resumedAt;
  episode.activeSince = resumedAt;
  episodes.push(episode);
  await writeEpisodes(episodes);
  return episode;
}

/** Old ledgers have no activeSince; lastActiveAt is their safest migration boundary. */
export function activeSegmentStartedAt(episode: Episode): string {
  return episode.activeSince ?? episode.lastActiveAt ?? episode.startedAt;
}

/** Retain earlier topic pages, refreshing pages touched in the newest segment. */
export function mergeTouchedPageSlugs(
  existing: readonly string[],
  touched: readonly TouchedPage[],
  limit = MAX_TOUCHED_PAGES,
): string[] {
  const recent = new Set<string>();
  for (const slug of existing) {
    recent.delete(slug);
    recent.add(slug);
  }
  for (const { slug } of touched) {
    recent.delete(slug);
    recent.add(slug);
  }
  return [...recent].slice(-Math.max(0, limit));
}

/**
 * Memory pages written since `sinceIso`, one entry per slug carrying its most
 * recent action.
 *
 * Deterministic and model-free: it reads the change journal the memory tools
 * already maintain, which is why the current (unsummarized) episode can still
 * show a useful working set. Most of those writes come from the background
 * memory agent, so this is often the only durable record the main agent has —
 * the per-turn memory note is ordinary history and compaction drops it.
 */
export async function touchedPagesSince(
  sinceIso: string,
  limit = MAX_TOUCHED_PAGES,
): Promise<TouchedPage[]> {
  const changes = await readMemoryChanges();
  const latest = new Map<string, MemoryChangeAction>();
  for (const change of changes) {
    if (change.kind !== 'page') continue;
    if (change.status === 'reverted') continue;
    if (change.at < sinceIso) continue;
    // The summarizer's own conversation pages are not part of the working set.
    if (change.slug.startsWith('conversations/')) continue;
    // Later entries win, and re-setting moves the slug to the end of the map
    // so insertion order stays "least recently written first".
    latest.delete(change.slug);
    latest.set(change.slug, change.action);
  }
  return [...latest.entries()].slice(-limit).map(([slug, action]) => ({ slug, action }));
}
