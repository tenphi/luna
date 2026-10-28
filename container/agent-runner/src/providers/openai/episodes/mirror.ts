/**
 * Memory mirror for closed episodes.
 *
 * Substantive episodes get a `conversations/<date>-<slug>` page so a topic from
 * three months ago is still findable by recall long after it fell off the
 * ledger. Long-horizon recall of past conversations is the point of writing
 * them, so these pages stay in semantic auto-recall — bounded and labelled
 * rather than excluded from explicit recall.
 *
 * **This is the write side of `<recent-conversations>`, and it went missing
 * once.** Every reader of `Episode.conversationPage` survived the move off the
 * previous memory backend; the writer was deleted with the backend's tooling,
 * because it called that backend's page tool by name. Nothing failed loudly —
 * an episode with no mirror looks exactly like an episode whose mirror has not
 * been written yet, so the ledger kept its summaries, the injected block kept
 * pointing at nothing, and `conversations/` simply stopped growing.
 *
 * The write goes through `dispatchMemoryMutation`, so it is journaled and
 * reversible by change id like every other memory write, and it reaches memory
 * over `callRaw` rather than a bridged alias: a system-owned write should not
 * depend on the tool being visible to the model.
 */
import { loadConfig } from '../../../config.js';
import { dispatchMemoryMutation, isMcpError } from '../tools/memory-mutations.js';
import { resolveTopicsConfig } from './config.js';
import { buildConversationPage, conversationSlug, summaryFromLedger } from './conversation-page.js';
import { readEpisodes, updateEpisode, type Episode } from './ledger.js';
import { formatSummaryBody, type EpisodeSummary } from './summarize.js';

// Re-exported: the page's name and shape are part of this module's surface for
// every caller, and pure enough to live next door and be rendered off-host.
export { buildConversationPage, conversationSlug, CONVERSATION_PREFIX } from './conversation-page.js';

/** The memory server, as the bridge names it. */
const MEMORY_SERVER = 'memory';

/**
 * Said once, on the first write into a base that has no `conversations/` rule
 * yet. `role: 'source'` is the load-bearing half: a transcript records what was
 * _said_, including options considered and dropped, so it is quoted rather than
 * mined for facts.
 */
const FOLDER_RULE = {
  path: 'conversations',
  description: 'Chat transcripts and discussion history; searchable evidence, not canonical claims.',
  role: 'source',
  remember: 'deny',
  type: 'conversation',
} as const;

export interface MirrorBridge {
  hasConnectedServer(name: string): boolean;
  callRaw(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
}

function log(msg: string): void {
  console.error(`[episodes] ${msg}`);
}

/**
 * Same day, same title, different episode: suffix rather than overwrite the
 * page the other one owns. Rewrites of the *same* episode keep their slug,
 * since it is recorded on the ledger entry.
 */
async function uniqueConversationSlug(episode: Episode): Promise<string> {
  const base = conversationSlug(episode);
  const episodes = await readEpisodes();
  const taken = episodes.some((e) => e.id !== episode.id && e.conversationPage === base);
  return taken ? `${base}-${episode.id.replace(/^ep_/, '').slice(-4)}` : base;
}

/** The `outcome` field of a memory op result, when it answered in its own JSON. */
function outcomeOf(result: string): string | null {
  try {
    const parsed = JSON.parse(result.replace(/\s*\(change id: [^)]+\)\s*$/, '')) as { outcome?: unknown };
    return typeof parsed.outcome === 'string' ? parsed.outcome : null;
  } catch {
    return null;
  }
}

/**
 * Write (or rewrite) the episode's conversation page and record the slug on the
 * ledger entry so the injected block can point the agent straight at it.
 */
export async function mirrorEpisodeToMemory(
  bridge: MirrorBridge | null,
  episode: Episode,
  summary: EpisodeSummary,
): Promise<string | null> {
  const topics = resolveTopicsConfig(loadConfig().context?.topics);
  if (!topics.mirrorToMemory) return null;
  if (!bridge?.hasConnectedServer(MEMORY_SERVER)) return null;

  const slug = episode.conversationPage ?? (await uniqueConversationSlug(episode));
  const write = (): Promise<string> =>
    dispatchMemoryMutation(
      (_name, args) => bridge.callRaw(MEMORY_SERVER, 'write', args),
      'memory_write',
      // `slug` and `content` are the whole surface here — see `buildConversationPage`.
      { slug, content: buildConversationPage(episode, summary) },
      {},
    );

  let result = await write();
  // A base with no `conversations/` rule yet asks what belongs there rather than
  // refusing. Declaring a folder is ungated and nobody is waiting on it, so say
  // it and repeat the write — this is the one caller that already knows the
  // answer, and asking the owner about it would be asking about our bookkeeping.
  if (outcomeOf(result) === 'requires_folder') {
    const declared = await bridge.callRaw(MEMORY_SERVER, 'folder', { ...FOLDER_RULE });
    if (isMcpError(declared)) {
      log(`Could not declare the conversations folder: ${declared.slice(0, 200)}`);
      return null;
    }
    result = await write();
  }

  if (isMcpError(result)) {
    log(`Conversation mirror failed for ${slug}: ${result.slice(0, 200)}`);
    return null;
  }
  const outcome = outcomeOf(result);
  // `noop` is a real success: memory found the page already saying this.
  if (outcome && outcome !== 'ok' && outcome !== 'noop') {
    log(`Conversation mirror for ${slug} came back "${outcome}" — leaving the page unwritten`);
    return null;
  }

  await updateEpisode(episode.id, { conversationPage: slug, summary: formatSummaryBody(summary) });
  log(`Mirrored ${episode.id} to ${slug}`);
  return slug;
}

/**
 * Pages per catch-up pass. Same reasoning as the summary drain's cap: the
 * container can be torn down mid-pass, so a bounded batch makes steady progress
 * where an unbounded one re-attempts the whole list and dies in the same place.
 */
const MAX_PER_PASS = 5;

/**
 * Mirror summarized episodes that have no page yet.
 *
 * The summary drain stamps `summarizedAt` before the mirror runs, which is
 * right — a summary that reached the ledger should not be paid for twice — but
 * it means a mirror that fails, or one that was never wired at all, is never
 * retried by that path. This is the catch-up: it works from the ledger's own
 * stored summary, so it needs no model call and no history file, and it heals
 * both cases. Trivial episodes never get a `summarizedAt` stamp, so they stay
 * out of it.
 */
export async function drainConversationMirrors(
  /** Resolved only when there is something to mirror, so a quiet pass connects nothing. */
  resolveBridge: () => MirrorBridge | null | Promise<MirrorBridge | null>,
): Promise<number> {
  const topics = resolveTopicsConfig(loadConfig().context?.topics);
  if (!topics.mirrorToMemory) return 0;

  // The tail entry is the live episode — it gets its page when it closes.
  const pending = (await readEpisodes())
    .slice(0, -1)
    .filter((e) => e.summarizedAt && !e.conversationPage && e.summary);
  if (pending.length === 0) return 0;

  const bridge = await resolveBridge();
  if (!bridge?.hasConnectedServer(MEMORY_SERVER)) return 0;

  // Newest first, for the same reason the summary drain works from that end.
  const batch = pending.slice(-MAX_PER_PASS).reverse();
  if (pending.length > batch.length) {
    log(`${pending.length} episodes without a conversation page — mirroring ${batch.length} this pass`);
  }

  let done = 0;
  for (const episode of batch) {
    const summary = summaryFromLedger(episode);
    if (!summary) continue;
    try {
      if (await mirrorEpisodeToMemory(bridge, episode, summary)) done++;
    } catch (err) {
      log(`Conversation mirror failed for ${episode.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done;
}
