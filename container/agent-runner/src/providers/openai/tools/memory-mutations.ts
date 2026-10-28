/**
 * Memory/skill mutation capture, gating, and the session journal.
 *
 * Every memory/skill write flows through `dispatchMemoryMutation`, which records the change in a
 * bounded per-session journal (`session_state`) and appends the change id to the tool result so it
 * lands in history.
 *
 * **Skills are the agent's own to write.** Creating, updating and deleting one is ungated: the
 * workspace is writable, a skill is a file the agent authored, and "delete skill X" has to work for
 * the owner to be able to undo a bad one by asking. There was a gate here once, reachable only by a
 * background writer that no longer exists — it routed a new skill to an approval card, and with
 * nothing left to set it, it was a branch that read like a policy and enforced nothing.
 *
 * The journal + declined-id blocklist live in host-owned `session_state` (persisted across
 * the ephemeral container), reached via the Session API.
 *
 * **This journal is what the session did, not what memory holds.** It used to snapshot a
 * page's prior text off disk and offer a revert that wrote the snapshot back — both of which
 * needed the knowledge base mounted into the container, which it is not and will not be.
 * Memory keeps its own history behind the door, and `memory_undo` reverses a change by id.
 */
import fs from 'fs';
import path from 'path';

import { getSessionClient } from '../../../session/client.js';
import { normalizeMemorySlug } from './memory-slug.js';

export const CHANGES_STATE_KEY = 'memory:changes';

const MAX_CHANGES = 20;

/**
 * Tools that change a page, under every name they arrive as.
 *
 * The bridge exposes a relayed op as `<server>_<op>`, so the agent calls `memory_write`; the
 * `mcp__memory__write` form shows up from a provider that does not use the alias map.
 */
const PAGE_MUTATORS = new Set([
  'memory_write',
  'memory_remember',
  'memory_retain',
  'memory_forget',
  'memory_move',
  'memory_ingest',
  'mcp__memory__write',
  'mcp__memory__remember',
  'mcp__memory__retain',
  'mcp__memory__forget',
  'mcp__memory__move',
  'mcp__memory__ingest',
]);

/**
 * The pages a memory op *reported* writing, read back out of its result.
 *
 * The arguments do not always say. `memory_remember` is handed text and memory decides which pages
 * the claims land on; `memory_retain` confirms its source page only in the receipt; `memory_ingest`
 * is handed a file and a folder and names the page it created; `memory_move` names `from`/`to` and
 * no `slug` at all. Slug-less calls used to fall out of this module at the `if (!slug)` line —
 * journalled nowhere, and answered without a change id.
 *
 * What that cost, on the Vulpine review of 2026-08-17: `memory_remember` created
 * `shopping/vulpine-sofa`, the journal recorded nothing, and the host's digest — which shapes its
 * mission around the pages the agent already wrote — was told only that *something* had been
 * written. It extracted the same warranty and feedback claims a second time, onto a second page.
 *
 * The result is memory's own JSON. A shape this does not recognise yields nothing, which is the
 * behaviour that was there before.
 */
export function writtenSlugs(result: string): string[] {
  try {
    const parsed = JSON.parse(result) as { wrote?: unknown; slug?: unknown };
    // `remember` reports a list, because one call can file claims onto several pages.
    if (Array.isArray(parsed.wrote)) {
      return parsed.wrote
        .map((entry) => (entry as { slug?: unknown } | null)?.slug)
        .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
    }
    // `ingest` reports the single page it made, under a different key. Read both rather than
    // falling back to the arguments: its own argument named `slug` is `path` — the *file* being
    // ingested — and journalling `/workspace/inbox/m-42/bill.pdf` as a page would put a filesystem
    // path in front of the extractor as somewhere a claim already lives.
    if (typeof parsed.slug === 'string' && parsed.slug.length > 0) return [parsed.slug];
    return [];
  } catch {
    return [];
  }
}

/** The page a memory write touched, from whichever argument that tool names it in. */
export function mutatedSlug(args: Record<string, unknown> | undefined): string | null {
  for (const key of ['slug', 'to', 'path']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // A write carrying an `event` and no slug goes to the ledger, which is a page like any other.
  // Without this the most visible write there is — "we did X today" landing on the timeline —
  // was recorded nowhere, so the turn looked as though it had touched nothing.
  if (args?.event !== undefined && args.event !== null) return 'timeline';
  return null;
}

/** Which of the four actions a tool name performs, for the change journal. */
export function mutationAction(name: string): MemoryChangeAction {
  const bare = name.replace(/^mcp__memory__/, '').replace(/^memory_/, '');
  if (bare === 'forget') return 'delete';
  if (bare === 'move') return 'move';
  return 'edit';
}

export type MemoryChangeAction = 'edit' | 'create' | 'delete' | 'move';
export type MemoryTargetKind = 'page' | 'skill' | 'file';

export interface MemoryChange {
  id: string;
  action: MemoryChangeAction;
  kind: MemoryTargetKind;
  slug: string;
  before: string | null;
  status: 'applied' | 'pending' | 'reverted';
  at: string;
  /** Destination slug for `move`. */
  to?: string;
}

export interface DispatchMutationOptions {
  /**
   * Hard-refuse any write to a `users/*` hot-memory page. Those pages are injected verbatim into
   * every turn their person speaks in, so a claim filed there becomes a standing instruction — they
   * are edited only when someone explicitly asks.
   *
   * No caller sets this today: it existed for a background writer that has been removed. Kept
   * because the thing it protects has not changed, and because the next background writer wants it
   * on from its first line rather than after the first surprise.
   */
  blockHotMemory?: boolean;
  /**
   * Hard-refuse any write to the `timeline` ledger. The ledger is date-ordered and memory appends
   * to it after the turn, under the right year.
   */
  blockLedger?: boolean;
}

/** Hot-memory pages live under `users/`. */
function isHotMemorySlug(slug: string): boolean {
  return slug === 'users' || slug.startsWith('users/');
}

/**
 * The ledger page, off-limits to the agent.
 *
 * The timeline is date-ordered under per-year headings, and memory writes it that way after the
 * turn — it knows the form and checks for a duplicate first. A `memory_write {slug: "timeline",
 * append: …}` cannot do either: `append` puts the line at the bottom of the page, below whatever
 * year happens to end it, which is the one place a chronological record must not grow. It also lets
 * the agent record its own turn as an event ("the daily review found nothing"), which is not
 * something that happened to anybody.
 */
function isLedgerSlug(slug: string): boolean {
  return slug === 'timeline';
}

type RawDispatch = (name: string, args: Record<string, unknown>) => Promise<string>;

export function genChangeId(): string {
  return `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function skillsRoot(): string {
  return process.env.LUNA_AGENT_SKILLS_PATH || '/workspace/agent/skills';
}

/**
 * A tool result that reports failure.
 *
 * String-sniffing is not a contract — memory answers in prose — so this is hygiene rather
 * than a check anything critical depends on. It deliberately errs wide: `^Error\b` catches
 * both "Error:" and the colon-less "Error creating page …" Luna's own helpers return.
 */
export function isMcpError(result: string): boolean {
  return /^(?:Error\b|Unknown tool:|Unknown MCP tool:|MCP tool error|MCP server not connected:)/i.test(result.trim());
}

function skillDir(name: string): string {
  return path.join(skillsRoot(), name);
}

function readSkillFile(name: string): string | null {
  try {
    return fs.readFileSync(path.join(skillDir(name), 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
}

// --- Journal (session_state) ---------------------------------------------

export async function readMemoryChanges(): Promise<MemoryChange[]> {
  try {
    const raw = await getSessionClient().getSessionState(CHANGES_STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MemoryChange[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeMemoryChanges(changes: MemoryChange[]): Promise<void> {
  const bounded = changes.slice(-MAX_CHANGES);
  await getSessionClient().setSessionState(CHANGES_STATE_KEY, JSON.stringify(bounded));
}

/** Append a change (read-modify-write; best-effort under rare cross-turn races). */
export async function appendMemoryChange(change: MemoryChange): Promise<void> {
  const changes = await readMemoryChanges();
  changes.push(change);
  await writeMemoryChanges(changes);
}

// --- Mutation dispatch ----------------------------------------------------

export function isMutatingMemoryTool(name: string): boolean {
  return PAGE_MUTATORS.has(name) || name === 'manage_skill' || name === 'forget_memory_fact';
}

export async function dispatchMemoryMutation(
  rawDispatch: RawDispatch,
  name: string,
  args: Record<string, unknown>,
  opts: DispatchMutationOptions,
): Promise<string> {
  // Page writes -------------------------------------------------------------
  if (PAGE_MUTATORS.has(name)) {
    const rawSlug = typeof args.slug === 'string' ? args.slug : '';
    const slug = rawSlug ? normalizeMemorySlug(rawSlug) : '';

    // Both blocks need the destination *before* the call, so they can only apply to a call that
    // named one as `slug`. Nothing is skipped by that: `remember` and `ingest` let memory choose the
    // page, while `retain` accepts only a source + remember-deny destination and confirms that page
    // in its receipt.
    if (slug) {
      if (opts.blockHotMemory && isHotMemorySlug(slug)) {
        return `Refusing to modify hot-memory page "${slug}". Hot memory (users/*) is edited only when the user explicitly asks. Store this on a durable topic/people page instead (e.g. people/<name>).`;
      }

      if (opts.blockLedger && isLedgerSlug(slug)) {
        return (
          'Refusing to write the timeline page directly. The ledger is date-ordered and memory ' +
          'appends to it after the turn, under the right year — an append from here lands at the ' +
          'bottom of the page, out of order. Put what happened on the page it belongs to and the ' +
          'ledger will follow. A review that found nothing is not an event: say so in your reply ' +
          'and record nothing. To reverse a change you just made, use memory_undo {change_id}.'
        );
      }
    }

    // The knowledge base is not mounted here, so the prior text cannot be read to journal it
    // and whether the page already existed cannot be known. Memory keeps its own history and
    // `memory_undo` reverses by change id; this journal is what the *session* did.
    const action = mutationAction(name);
    const before = null;

    // A write into a folder that does not exist is gated by **memory**, which knows the folder
    // structure and returns `requires_approval` with the owner's decision attached. This used to
    // be guessed here from a directory listing the container cannot see, which meant the guess
    // was "everything is new" — a gate that fires on every write is a stop, not a gate.

    const result = await rawDispatch(name, args);
    if (isMcpError(result)) return result;

    // Where it landed, from the only three places that can honestly say: the slug the call named,
    // `move`'s destination, or the result for the ops that choose the page themselves.
    //
    // Deliberately *not* `mutatedSlug(args)` as a catch-all. That helper also reads `path`, which on
    // an `ingest` is the file being ingested rather than any page — journalling it would put a
    // filesystem path into the digest's mission as somewhere a claim already lives.
    const named = slug || (typeof args.to === 'string' && args.to.trim() ? normalizeMemorySlug(args.to) : '');
    const touched = named ? [named] : writtenSlugs(result);
    // Nothing to journal and nothing to say: an op that reported no page did not change one.
    if (touched.length === 0) return result;

    // One id for the call, not one per page. A `remember` that files three claims onto three pages
    // is a single thing the owner asked for and a single thing "undo that" has to mean.
    const changeId = genChangeId();
    for (const page of touched) {
      await appendMemoryChange({
        id: changeId,
        action,
        kind: 'page',
        slug: page,
        before,
        status: 'applied',
        at: new Date().toISOString(),
      });
    }
    return `${result} (change id: ${changeId})`;
  }

  // Skill writes ------------------------------------------------------------
  if (name === 'manage_skill') {
    const skillAction = typeof args.action === 'string' ? args.action : '';
    if (skillAction !== 'create' && skillAction !== 'update' && skillAction !== 'delete') {
      return rawDispatch(name, args); // list / read — not mutating
    }
    const skillName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!skillName) return rawDispatch(name, args);
    const before = readSkillFile(skillName);

    const result = await rawDispatch(name, args);
    if (isMcpError(result)) return result;
    const changeId = genChangeId();
    await appendMemoryChange({
      id: changeId,
      action: skillAction === 'create' ? 'create' : skillAction === 'delete' ? 'delete' : 'edit',
      kind: 'skill',
      slug: skillName,
      before,
      status: 'applied',
      at: new Date().toISOString(),
    });
    return `${result} (change id: ${changeId})`;
  }

  // forget_memory_fact and anything else: pass through (tracked for skip only).
  return rawDispatch(name, args);
}
