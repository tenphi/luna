import type { TopicDecisionFn } from './decisions.js';
/**
 * Applying a topic decision to the session: which history file this turn runs
 * on, what closes behind it, and what the poll loop should surface.
 *
 * The ledger is authoritative for the history file. The poll loop's stored
 * continuation is only a hint — it is re-synced from the `init` event we yield
 * after this resolves.
 */
import type { AttachmentEvidence } from '../../../attachment-digest.js';
import type { ReplyEvidence } from '../../../formatter.js';
import { loadHistory, loadSession, newSessionId } from '../session-store.js';
import type { ChatMessage } from '../types.js';
import {
  clipChars,
  countUserTurns,
  DEFAULT_EMOJI,
  deterministicTitle,
  episodeTranscript,
  historyContainsQuote,
  textSignature,
  UNTITLED_TOPIC,
} from './format.js';
import {
  activeSegmentStartedAt,
  appendEpisode,
  currentEpisode,
  mergeTouchedPageSlugs,
  readEpisodes,
  resumeEpisode,
  touchedPagesSince,
  touchEpisode,
  updateEpisode,
  type Episode,
} from './ledger.js';
import { decideEpisode, type MemoryChatFn, type ReplyTarget } from './decide.js';
import type { PendingTopicAction } from './tools.js';

/** An episode needs at least this many user turns to be worth a model summary. */
export const SUBSTANTIVE_EXCHANGES = 2;

/**
 * Free-gate continues that carry no subject of their own. They are real turns,
 * but stamping the episode active on them hides the gap the next message
 * actually arrived after — see `resolveEpisodeForTurn`.
 */
const UNSTAMPED_CONTINUE_REASONS = new Set(['empty-message', 'greeting-only']);

/** Provisional summary length — enough to recognize the topic, cheap to carry. */
const PROVISIONAL_SUMMARY_CHARS = 300;

export interface TopicEvent {
  action: 'new' | 'resumed';
  episodeId: string;
  title: string;
  emoji: string;
  /** For `resumed`: when that topic was last active, before this turn. */
  lastActiveAt?: string;
  /** The session's first episode — nothing to signal a switch *from*. */
  first: boolean;
  /** The closed episode left nothing meaningful behind. */
  closedTrivial: boolean;
}

export interface ResolveEpisodeInput {
  /** Raw user text for this turn. */
  userText: string;
  /** Continuation the poll loop had, if its history file still exists. */
  continuation: string | null;
  /** History already loaded for `continuation`. */
  history: ChatMessage[];
  continueWindowMinutes?: number;
  /** What the runtime read out of this message's attachments, as topic evidence. */
  attachments?: AttachmentEvidence;
  /** The message this turn replies to, when the channel carried a reply link. */
  replyTo?: ReplyEvidence;
  now?: Date;
  /** Injectable for tests. */
  chat?: MemoryChatFn;
  decisions?: TopicDecisionFn;
}

export interface EpisodeTurn {
  historyId: string;
  history: ChatMessage[];
  current: Episode;
  /** Set only for a real topic boundary, never for internal re-syncs. */
  event?: TopicEvent;
  /** The classifier failed, so continuity is provisional. */
  uncertain?: true;
}

function log(msg: string): void {
  console.error(`[episodes] ${msg}`);
}

/** An episode that reached neither two exchanges nor a memory write. */
export function isTrivialEpisode(episode: Episode): boolean {
  return (episode.exchanges ?? 0) < SUBSTANTIVE_EXCHANGES && episode.slugs.length === 0;
}

/** Episodes whose close still needs the background summarizer. */
export function needsSummary(episode: Episode): boolean {
  return !episode.summarizedAt && !isTrivialEpisode(episode);
}

function provisionalSummary(history: ChatMessage[]): string | null {
  if (history.length === 0) return null;
  return episodeTranscript(history, PROVISIONAL_SUMMARY_CHARS, 160).trim() || null;
}

/**
 * Snapshot what the episode leaves behind. The provisional summary matters more
 * than it looks: `<recent-conversations>` is the safety net for a false-positive
 * switch, and without it that net has a hole for the first turn after every
 * switch — precisely when a mis-classification surfaces.
 */
async function closeEpisode(episode: Episode, history: ChatMessage[]): Promise<Episode> {
  const exchanges = countUserTurns(history);
  // A resumed-then-closed episode has new material, so re-summarize it — but
  // only when something was actually said. Alternating between two topics
  // closes both repeatedly, and clearing the stamp unconditionally puts every
  // one of those closes back in the drain queue for a transcript that has not
  // changed.
  const reopened = exchanges > (episode.exchanges ?? 0);
  const touched = await touchedPagesSince(activeSegmentStartedAt(episode));
  const patch = {
    activeSince: undefined,
    slugs: mergeTouchedPageSlugs(episode.slugs, touched),
    exchanges,
    summary: episode.summary ?? provisionalSummary(history),
    summarizedAt: reopened ? undefined : episode.summarizedAt,
  };
  const updated = await updateEpisode(episode.id, patch);
  return updated ?? { ...episode, ...patch };
}

function historyFor(episode: Episode, input: ResolveEpisodeInput): ChatMessage[] {
  if (episode.historyId === input.continuation) return input.history;
  return loadHistory(episode.historyId) ?? [];
}

/** Leading chars of a quote used to identify it — see `historyContainsQuote`. */
const REPLY_MATCH_CHARS = 120;
/**
 * Shorter than this, a quote signature identifies nothing: "ok" or "thanks"
 * appears in every episode, and the first one scanned would win.
 */
const REPLY_MATCH_MIN_CHARS = 14;
/**
 * How far back to look for the quoted message. Each miss is a history file read,
 * and a reply to something older than this is rare enough to leave to the
 * classifier, which sees the quote either way.
 */
const REPLY_SEARCH_EPISODES = 12;

/**
 * Which episode holds the message the user replied to.
 *
 * Text, not ids: the platform message id would need a host round-trip and a
 * per-message episode index that nothing keeps, while the quoted words are
 * already in hand and sit in exactly one episode's history. Newest first, so a
 * message quoted twice resolves to where it was said most recently.
 */
function placeReply(episodes: Episode[], needle: string, input: ResolveEpisodeInput): string | null {
  for (const episode of episodes.slice(-REPLY_SEARCH_EPISODES).reverse()) {
    if (historyContainsQuote(historyFor(episode, input), needle)) return episode.id;
  }
  return null;
}

/** The reply hint for the decision, or undefined when this turn is not a reply. */
function replyTarget(episodes: Episode[], input: ResolveEpisodeInput): ReplyTarget | undefined {
  const quote = input.replyTo?.text?.trim();
  if (!quote) return undefined;

  const needle = clipChars(textSignature(quote), REPLY_MATCH_CHARS).trim();
  // A quote this short identifies no message and tells the classifier nothing
  // either — replying to "Thanks!" is not a topic signal. Drop it entirely so
  // the free gate keeps its cheap answer.
  if (needle.length < REPLY_MATCH_MIN_CHARS) {
    log('Reply quotes too little text to place — deciding on the message alone');
    return undefined;
  }

  const episodeId = placeReply(episodes, needle, input);
  const target = episodeId ? episodes.find((e) => e.id === episodeId) : undefined;
  log(
    target
      ? `Reply quotes a message from ${target.id} (${target.emoji} ${target.title})`
      : 'Reply quotes a message no episode in the ledger contains',
  );
  return { text: quote, episodeId };
}

/**
 * Decide and apply. Returns the history file for this turn plus the topic event
 * (if any). Never throws: a failed decision continues the current episode.
 */
export async function resolveEpisodeForTurn(input: ResolveEpisodeInput): Promise<EpisodeTurn> {
  let episodes = await readEpisodes();

  // Adopt a pre-episode session so upgrading an install doesn't orphan the
  // history that is already there. `lastActiveAt` has to come from the history
  // file: stamping it `now` would tell the free gate this topic was active a
  // second ago, so the first message after an upgrade could never switch.
  if (episodes.length === 0 && input.continuation && input.history.length > 0) {
    const adopted = await appendEpisode({
      title: 'Earlier conversation',
      emoji: DEFAULT_EMOJI,
      historyId: input.continuation,
      lastActiveAt: loadSession(input.continuation)?.updated_at,
    });
    log(`Adopted existing history ${input.continuation} as ${adopted.id}`);
    episodes = [adopted];
  }

  const outgoing = episodes[episodes.length - 1];

  // A caption-less attachment leaves `userText` empty, so the filename is the
  // only human-readable name on offer — and it beats both a line of OCR and
  // the XML fragment the envelope fallback used to produce.
  const titleSource = input.userText.trim() || input.attachments?.titleHint || '';

  // `/clear` left a fresh, unnamed episode behind — name it from this message
  // rather than deciding against a topic that has nothing in it yet.
  if (outgoing && outgoing.title === UNTITLED_TOPIC && outgoing.exchanges === undefined) {
    const pending = historyFor(outgoing, input);
    if (pending.length === 0) {
      const renamed = await updateEpisode(outgoing.id, {
        title: deterministicTitle(titleSource),
        lastActiveAt: new Date().toISOString(),
      });
      return { historyId: outgoing.historyId, history: pending, current: renamed ?? outgoing };
    }
  }

  const decision = await decideEpisode({
    userText: input.userText,
    episodes,
    history: input.history,
    now: input.now,
    continueWindowMinutes: input.continueWindowMinutes,
    attachments: input.attachments,
    reply: replyTarget(episodes, input),
    chat: input.chat,
    decisions: input.decisions,
  });
  log(`Decision: ${decision.action} (${decision.reason}${decision.uncertain ? ', uncertain' : ''})`);

  if (decision.action === 'resume' && decision.episodeId && outgoing) {
    const target = episodes.find((e) => e.id === decision.episodeId);
    const lastActiveAt = target?.lastActiveAt;
    await closeEpisode(outgoing, input.history);
    const resumed = await resumeEpisode(decision.episodeId);
    if (resumed) {
      return {
        historyId: resumed.historyId,
        history: historyFor(resumed, input),
        current: resumed,
        event: {
          action: 'resumed',
          episodeId: resumed.id,
          title: resumed.title,
          emoji: resumed.emoji,
          lastActiveAt,
          first: false,
          // A resume always announces: knowing which thread was picked up is
          // the whole value.
          closedTrivial: false,
        },
      };
    }
  }

  if (decision.action === 'new') {
    const closed = outgoing ? await closeEpisode(outgoing, input.history) : undefined;
    const opened = await appendEpisode({
      title: decision.title ?? deterministicTitle(titleSource),
      emoji: decision.emoji ?? DEFAULT_EMOJI,
      historyId: newSessionId(),
    });
    return {
      historyId: opened.historyId,
      history: [],
      current: opened,
      event: {
        action: 'new',
        episodeId: opened.id,
        title: opened.title,
        emoji: opened.emoji,
        first: !outgoing,
        closedTrivial: closed ? isTrivialEpisode(closed) : false,
      },
    };
  }

  // Continue. `outgoing` is always set here: an empty ledger decides `new`.
  if (!outgoing) {
    const opened = await appendEpisode({
      title: deterministicTitle(titleSource),
      emoji: DEFAULT_EMOJI,
      historyId: input.continuation ?? newSessionId(),
    });
    return { historyId: opened.historyId, history: input.history, current: opened };
  }

  // A continue that said nothing about the subject must not restart the idle
  // clock. "Hey!" followed by the real request a minute later would otherwise
  // present that request as arriving mid-conversation, when the gap it actually
  // left is the evidence the gate needs.
  if (!UNSTAMPED_CONTINUE_REASONS.has(decision.reason)) await touchEpisode(outgoing.id);
  return {
    historyId: outgoing.historyId,
    history: historyFor(outgoing, input),
    current: (await currentEpisode()) ?? outgoing,
    ...(decision.uncertain ? { uncertain: true as const } : {}),
  };
}

/**
 * Close the current episode and open an empty one — the `/clear` path. Archives
 * and summarizes instead of dropping context on the floor. Without an explicit
 * name the new episode is named by the next message.
 */
export async function closeCurrentEpisode(
  history: ChatMessage[],
  named?: { title: string; emoji: string },
): Promise<{ closed: Episode | null; opened: Episode }> {
  const outgoing = await currentEpisode();
  const closed = outgoing ? await closeEpisode(outgoing, history) : null;
  const opened = await appendEpisode({
    title: named?.title ?? UNTITLED_TOPIC,
    emoji: named?.emoji ?? DEFAULT_EMOJI,
    historyId: newSessionId(),
  });
  return { closed, opened };
}

/**
 * Apply an agent-requested switch (`start_new_topic` / `resume_topic`) once the
 * turn that requested it has been saved. Returns the history file the next
 * message should run on, or null when the target vanished meanwhile.
 */
export async function applyTopicAction(
  action: PendingTopicAction,
  history: ChatMessage[],
): Promise<{ historyId: string; history: ChatMessage[]; current: Episode } | null> {
  if (action.kind === 'new') {
    const { opened } = await closeCurrentEpisode(history, { title: action.title, emoji: action.emoji });
    log(`Agent opened ${opened.id} (${opened.title})`);
    return { historyId: opened.historyId, history: [], current: opened };
  }

  const outgoing = await currentEpisode();
  if (outgoing) await closeEpisode(outgoing, history);
  const resumed = await resumeEpisode(action.episodeId);
  if (!resumed) {
    log(`Agent asked to resume ${action.episodeId}, which is no longer in the ledger`);
    return null;
  }
  log(`Agent resumed ${resumed.id} (${resumed.title})`);
  return {
    historyId: resumed.historyId,
    history: loadHistory(resumed.historyId) ?? [],
    current: resumed,
  };
}
