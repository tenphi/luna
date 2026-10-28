/**
 * Reading and correcting memory by hand, without going through the agent.
 *
 * These used to run inside the container, against a knowledge base it had mounted and a backend
 * binary on its PATH. Neither survived the move to memory-as-a-service: the container has no mount
 * and nothing behind the binary, so every one of them answered "the knowledge base is not
 * available". They are host-side now for the reason they were written in the first place — the
 * moment you most want to look something up by hand is when the agent is wedged, and a command
 * that needs a healthy container to answer is missing exactly then.
 *
 * All of them are back except `/query`, which was a second search with no chat model behind it —
 * what `recall` already is. The rest each answer a question none of the others do: `/raw` gives the
 * page as stored rather than as read, `/delete` removes a page where `/forget` removes a sentence,
 * and `/restore` asks "what did I delete, and put that one back" where `/undo` asks "reverse the
 * last thing that happened". `/undo` is new, and is the reversal the others point at.
 */
import fs from 'fs';
import path from 'path';

import type { Line } from '@tenphi/akno-client';

import { MemoryUnavailable, memory, retryRead, withMemory } from './client.js';
import { isSafeAttachmentName } from '../attachment-safety.js';
import { sessionDir } from '../session-manager.js';
import { log } from '../log.js';

/**
 * One outbound row a command wants written.
 *
 * Only `/download` needs more than a string: Telegram's adapter throws on a message carrying two
 * uploads, and it throws inside delivery — so a single row with several files never succeeds and
 * the sweep retries it until its attempt budget runs out. One file per row, always.
 */
export interface MemoryReply {
  text: string;
  /** Names inside this row's outbox directory, which `id` identifies. */
  files?: string[];
  id?: string;
}

/** Where the command is running, for the one command that has to put files somewhere. */
export interface MemoryCommandContext {
  agentGroupId: string;
  sessionId: string;
}

/** The commands handled here. The router asks this before it wakes a container. */
export const MEMORY_COMMANDS = new Set([
  '/read',
  '/raw',
  '/list',
  '/timelines',
  '/timeline',
  '/recall',
  '/forget',
  '/delete',
  '/restore',
  '/undo',
  '/download',
]);

/** Keeps one page reply inside a few chat messages; the adapter splits at 3500 characters. */
const MAX_PAGE_CHARS = 6000;
const MAX_RECALL_CARDS = 5;
const MAX_LINES_PER_CARD = 4;
const MAX_LIST_ENTRIES = 40;

/**
 * Run one command and return what to say.
 *
 * Never throws: a slash command that answers with a stack trace is worse than one that answers
 * with a sentence. An unreachable service is reported as an outage in those words, because
 * "nothing found" would read as "your memory is empty".
 */
export async function runMemoryCommand(
  command: string,
  argument: string,
  ctx?: MemoryCommandContext,
): Promise<string | MemoryReply[]> {
  try {
    switch (command) {
      case '/read':
        return await readPage(argument, { raw: false });
      case '/raw':
        return await readPage(argument, { raw: true });
      case '/list':
        return await listFolder(argument);
      case '/timelines':
        return await listTimelines();
      case '/timeline':
        return await readTimeline(argument);
      case '/recall':
        return await recall(argument);
      case '/forget':
        return await forget(argument);
      case '/delete':
        return await deletePage(argument);
      case '/restore':
        return await restore(argument);
      case '/undo':
        return await undo(argument);
      case '/download':
        return ctx ? await download(argument, ctx) : 'Downloads are not available here.';
      default:
        return `${command} is not a memory command.`;
    }
  } catch (err) {
    if (err instanceof MemoryUnavailable) {
      return '🧠 Memory is not answering. This is an outage, not an empty memory — nothing has been lost.';
    }
    log.warn('memory command failed', { command, err });
    return `Could not run ${command}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function listTimelines(): Promise<string> {
  const result = await retryRead((client) => client.call('list', { kind: 'timelines' }));
  const lines = [`Timelines (${result.status}):`];
  for (const entry of (result.timelines ?? []).slice(0, MAX_LIST_ENTRIES)) {
    lines.push(
      `• \`${entry.slug}\` — ${entry.title}${entry.default ? ' (default)' : ''}; ${entry.status}, ${entry.writable ? 'writable' : 'not writable'}`,
    );
    if (entry.description) lines.push(`  ${entry.description}`);
    if (entry.note) lines.push(`  ${entry.note}`);
  }
  if (result.total > MAX_LIST_ENTRIES)
    lines.push(`… ${result.total - MAX_LIST_ENTRIES} more; use \`luna memory timelines\` for the complete list.`);
  if (result.status === 'degraded' || result.status === 'unavailable')
    lines.push('Discovery is incomplete; missing timelines do not prove absence.');
  lines.push('Read: `/timeline <ledger|*> [since] [until]`. Root excludes nested timelines; * combines all.');
  return lines.join('\n');
}

async function readTimeline(argument: string): Promise<string> {
  const parts = argument.trim().split(/\s+/);
  const [timeline, since, until] = parts;
  if (!timeline || parts.length > 3 || [since, until].some((date) => date && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(date))) {
    return 'Usage: `/timeline <ledger|*> [since] [until]` — dates are YYYY, YYYY-MM or YYYY-MM-DD. Discover with `/timelines`.';
  }
  const result = await retryRead((client) =>
    client.call('timeline', { timeline, ...(since ? { since } : {}), ...(until ? { until } : {}), limit: 20 }),
  );
  const lines = [`Timeline ${result.selected_timelines?.join(', ') ?? timeline} (${result.status}):`];
  for (const entry of result.results) {
    const location =
      entry.type === 'document_evidence' ? entry.path : entry.type === 'event' ? entry.source : entry.slug;
    const summary =
      entry.type === 'document_evidence'
        ? `${entry.label} — ${entry.date_basis}${entry.quote ? `: ${entry.quote}` : ''}`
        : entry.summary;
    const qualifications = [
      entry.source_kind,
      entry.temporal_status,
      entry.disposition,
      entry.clock_relation,
      entry.type === 'document_evidence' ? entry.availability : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `• ${entry.start ?? ('date' in entry ? entry.date : 'undated')}: ${summary}\n  ${qualifications} · \`${location}\`${entry.type !== 'document_evidence' && entry.line ? `:${entry.line}` : ''}${entry.timeline ? ` · timeline \`${entry.timeline}\` (${entry.timeline_basis ?? 'unspecified basis'})` : ''}`,
    );
  }
  if (result.status === 'empty') lines.push('No entries in this selection.');
  if (result.status === 'degraded' || result.status === 'unavailable')
    lines.push('History is incomplete; missing entries do not prove absence.');
  if (result.total > result.results.length || result.truncated)
    lines.push('More entries may exist; narrow the dates or use `luna memory timeline` with filters.');
  return lines.join('\n');
}

/**
 * `/read` renders a page for a person; `/raw` hands back what is on disk.
 *
 * They are not the same question. `/read` drops the frontmatter, because six lines of `type:` and
 * `created_at:` before the first sentence is the page's filing metadata and on a phone it is most of
 * the screen. `/raw` keeps it, because the reason to ask for raw is to see the file — the tags it
 * carries, the wikilinks unrendered — usually before editing it or reporting something odd about it.
 */
async function readPage(argument: string, options: { raw: boolean }): Promise<string> {
  const command = options.raw ? '/raw' : '/read';
  const slug = argument.trim().replace(/^\/+|\.md$/g, '');
  if (!slug) return `Usage: \`${command} <page>\` — e.g. \`${command} people/jane\`. Use \`/list\` to browse.`;

  const result = await retryRead((client) => client.call('read', { slug }));
  const page = (result as { page?: { slug: string; title: string; summary: string | null; lines: Line[] } }).page;
  if (!page) return notFound(slug);

  const body = (options.raw ? page.lines : stripFrontmatter(page.lines))
    .map((line) => line.text)
    .join('\n')
    .trim();
  if (!body) return `📄 ${page.slug} is empty.`;

  const clipped = body.length > MAX_PAGE_CHARS ? `${body.slice(0, MAX_PAGE_CHARS).trimEnd()}\n\n…truncated.` : body;
  // Fenced, so nothing between here and the chat client re-renders the markdown that was asked for
  // verbatim — an unrendered page is the entire point of the command.
  return options.raw
    ? `📄 **${page.slug}** (as stored)\n\n\`\`\`markdown\n${clipped}\n\`\`\``
    : `📄 **${page.slug}**\n\n${clipped}`;
}

async function listFolder(argument: string): Promise<string> {
  const folder = argument.trim().replace(/^\/+|\/+$/g, '');
  const result = await retryRead((client) => client.call('list', folder ? { folder, kind: 'pages' } : {}));
  const { folders = [], pages = [] } = result as {
    folders?: { path: string; pages: number; pages_deep: number }[];
    pages?: { slug: string; title: string }[];
  };

  if (folders.length === 0 && pages.length === 0) {
    return folder ? `📂 Nothing in \`${folder}\`. Use \`/list\` for the top level.` : '📂 Memory is empty.';
  }

  const lines = [folder ? `📂 **${folder}**` : '📂 **Memory**', ''];
  for (const entry of folders.slice(0, MAX_LIST_ENTRIES)) {
    lines.push(`📁 \`${entry.path}\` (${entry.pages_deep} pages)`);
  }
  for (const page of pages.slice(0, MAX_LIST_ENTRIES)) lines.push(`📄 \`${page.slug}\``);

  const hidden = Math.max(0, folders.length - MAX_LIST_ENTRIES) + Math.max(0, pages.length - MAX_LIST_ENTRIES);
  if (hidden > 0) lines.push(`… and ${hidden} more`);

  // The next command, spelled out. Both take exactly the paths printed above.
  if (folders.length > 0) lines.push('', `Open a folder: \`/list ${folders[0]!.path}\``);
  if (pages.length > 0) lines.push(`Read a page: \`/read ${pages[0]!.slug}\``);
  return lines.join('\n');
}

/**
 * Search, showing what each hit is retractable by.
 *
 * The fact ids are the point of printing lines rather than summaries: `/forget` takes one, and a
 * search that shows a wrong sentence without offering the handle to remove it leaves the owner
 * with a complaint and no way to act on it.
 */
async function recall(argument: string): Promise<string> {
  const query = argument.trim();
  if (!query) return 'Usage: `/recall <what you are looking for>`.';

  const result = await retryRead((client) => client.call('recall', { query }));
  const { status } = result;
  const memoryView = isMemoryView((result as { memory_view?: unknown }).memory_view) ? result.memory_view : 'factual';
  const pages = result.results.filter((entry) => entry.type === 'page');

  if (pages.length === 0) {
    return status === 'degraded'
      ? `🧠 Nothing found for "${query}" — but part of the search was unavailable, so this does not mean it is not there.`
      : `🧠 Nothing in memory about "${query}".`;
  }

  const lines: string[] = [`🧠 **${query}**`, ''];
  let retractable = 0;
  for (const card of pages.slice(0, MAX_RECALL_CARDS)) {
    lines.push(`📄 \`${card.slug}\``);
    const rejectedQualification = card.lines.some(
      (line) =>
        line.observation?.status === 'ineligible' ||
        retainedMemoryQualification(line) === null ||
        (memoryView === 'factual' && retainedMemoryIsNonFactual(line)),
    );
    const quoted = card.lines
      .filter(
        (line) =>
          line.text.trim() &&
          line.observation?.status !== 'ineligible' &&
          retainedMemoryQualification(line) !== null &&
          !(memoryView === 'factual' && retainedMemoryIsNonFactual(line)),
      )
      .slice(0, MAX_LINES_PER_CARD);
    for (const line of quoted) {
      // The id goes on the line it belongs to. Collected into a legend at the bottom it would be
      // one more thing to cross-reference before you can correct a single wrong sentence.
      const retainedMemory = retainedMemoryQualification(line);
      // A managed-memory id removes the complete sealed block and its retained support. Prefer it
      // over the derived fact id when both exist; plans, reports and questions have no fact id at all.
      const retractableId = retainedMemory?.id ?? line.fact;
      const handle = retractableId ? ` · \`${retractableId}\`` : '';
      const observation =
        line.observation?.status === 'eligible'
          ? ` · _derived observation, ${line.observation.proof_count} independent proofs_ · support: ${line.observation.evidence
              .slice(0, 3)
              .map((entry) => `\`${entry.slug}:${entry.line}\``)
              .join(', ')}`
          : '';
      const retained = renderRetainedMemory(line, memoryView);
      lines.push(`   ${line.text.trim().slice(0, 200)}${handle}${observation}${retained}`);
      if (retractableId) retractable += 1;
    }
    // A summary may have been derived from the page text. Do not use it as a back door around an
    // explicit ineligible qualification when that is the only line the card supplied.
    if (quoted.length === 0 && card.summary && !rejectedQualification) lines.push(`   ${card.summary.slice(0, 200)}`);
    lines.push('');
  }

  if (status === 'degraded') lines.push('_Part of the search was unavailable — this may be incomplete._');
  if (retractable > 0) lines.push('Wrong? `/forget <id>` removes that exact item.');
  return lines.join('\n').trimEnd();
}

interface RenderableMemory {
  id: string;
  kind: string;
  source_role: string;
  source_speaker?: string;
  commitment: string;
  disposition: string;
  polarity: string;
  basis: string;
  answer_eligible: boolean;
  current_eligible: boolean;
}

const MEMORY_VIEWS = ['factual', 'history', 'planning', 'reports', 'questions', 'discussion', 'all'] as const;

function isMemoryView(value: unknown): value is (typeof MEMORY_VIEWS)[number] {
  return typeof value === 'string' && (MEMORY_VIEWS as readonly string[]).includes(value);
}

/** `undefined` means an ordinary line; `null` is a qualification that must fail closed. */
function retainedMemoryQualification(line: Line): RenderableMemory | null | undefined {
  const memory = (line as unknown as { memory?: Record<string, unknown> | null }).memory;
  if (memory === undefined) return undefined;
  if (!memory || memory.status !== 'qualified') return null;

  if (
    typeof memory.id !== 'string' ||
    !memory.id ||
    memory.level !== 1 ||
    typeof memory.kind !== 'string' ||
    !['claim', 'decision', 'preference', 'plan', 'event', 'question'].includes(memory.kind) ||
    typeof memory.subject !== 'string' ||
    !memory.subject ||
    typeof memory.source_role !== 'string' ||
    !['user', 'assistant', 'external', 'unknown'].includes(memory.source_role) ||
    (memory.source_speaker !== undefined && typeof memory.source_speaker !== 'string') ||
    typeof memory.commitment !== 'string' ||
    !['asserted', 'tentative', 'hypothetical', 'counterfactual', 'none'].includes(memory.commitment) ||
    typeof memory.disposition !== 'string' ||
    !['active', 'proposed', 'accepted', 'rejected', 'resolved', 'cancelled', 'completed', 'superseded'].includes(
      memory.disposition,
    ) ||
    typeof memory.polarity !== 'string' ||
    !['affirmed', 'negated'].includes(memory.polarity) ||
    typeof memory.basis !== 'string' ||
    !['self_attested', 'source_report', 'cited_evidence', 'system_record'].includes(memory.basis) ||
    typeof memory.answer_eligible !== 'boolean' ||
    typeof memory.current_eligible !== 'boolean'
  ) {
    return null;
  }

  return memory as unknown as RenderableMemory;
}

function retainedMemoryIsNonFactual(line: Line): boolean {
  const memory = retainedMemoryQualification(line);
  return memory !== undefined && memory !== null && (!memory.answer_eligible || !memory.current_eligible);
}

/** Keep source-native retained memory contextual instead of presenting every matching line as fact. */
function renderRetainedMemory(line: Line, memoryView: string): string {
  const memory = retainedMemoryQualification(line);
  if (!memory) return '';

  const source = memory.source_speaker ? `${memory.source_role}: ${memory.source_speaker}` : memory.source_role;
  const eligibility =
    memory.answer_eligible && memory.current_eligible
      ? 'ordinary-answer eligible'
      : `context for ${memoryView || 'the selected view'}, not an ordinary fact`;
  return (
    ` · _retained ${memory.kind}; ${memory.commitment}; ${memory.disposition}; ${memory.polarity}; ` +
    `${memory.basis.replaceAll('_', ' ')}; source ${source}; ${eligibility}_`
  );
}

/**
 * Fact ids are `fct_…`; anything else the owner types is a page.
 *
 * The prefix, not the hex body after it. Matching the body would mean that the day an id gains a
 * character outside `[0-9a-f]`, every `/forget` quietly reinterprets it as a page slug and answers
 * "no page fct_… in memory" — a confusing reply to a correct command.
 */
function looksLikeFactId(argument: string): boolean {
  return /^fct_\w+$/i.test(argument);
}

function looksLikeMemoryId(argument: string): boolean {
  return /^mem_[a-z0-9_-]+$/i.test(argument);
}

/**
 * Retract one sentence.
 *
 * This is memory's `forget`, not the one this command used to be. The old one expired a row in a
 * database while the sentence stayed in the file, so the assistant forgot a claim and then read it
 * again the next day — worse than not forgetting, because the two then disagreed.
 *
 * A page slug is redirected to `/delete` rather than accepted. The op takes either, but one command
 * that removes a sentence or an entire page depending on how its argument is spelled is a command
 * where a typo is the difference between correcting a detail and deleting everything around it.
 */
async function forget(argument: string): Promise<string> {
  const target = argument.trim();
  if (!target) {
    return 'Usage: `/forget <what is wrong>` — e.g. `/forget the rent is 1200`. An id from `/recall` works too.';
  }
  // Nobody knows a retraction id off the top of their head. What they know is the sentence that is
  // wrong, so anything that is not already an id is searched for and the matches are offered back
  // with their ids — which turns "how do I find the id" into a step you do not have to take.
  const input = looksLikeFactId(target) ? { fact: target } : looksLikeMemoryId(target) ? { memory: target } : null;
  if (!input) return findForForgetting(target);

  const result = (await withMemory((client) => client.call('forget', input))) as {
    change_id?: string;
    removed?: string;
    removed_from?: string;
  };

  const undoHint = result.change_id ? `\n\nUndo: \`/undo ${result.change_id}\`` : '';
  if (result.removed) {
    const removed = presentRemovedMemory(result.removed);
    return `🗑️ Removed from \`${result.removed_from}\`:\n\n> ${removed}${undoHint}`;
  }
  return `🗑️ Removed.${undoHint}`;
}

/** Akno returns exact removed bytes; hide its managed marker while keeping the user-authored payload. */
function presentRemovedMemory(removed: string): string {
  return removed
    .split('\n')
    .filter((line) => !/^<!--\s*akno:item\b.*-->$/i.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * Turn "what is wrong" into the handle that removes it.
 *
 * The alternative was telling people to run `/recall` first and copy an id out of the output, which
 * is a fine answer for someone who already knows the command exists and a dead end for everyone
 * else. Searching here costs one recall and puts the id next to the sentence it removes.
 *
 * It never retracts on its own. A search that is confident enough to delete a sentence without
 * being shown it is a search that will eventually delete the wrong one, and the whole point of this
 * command is to fix a memory that got something wrong.
 */
async function findForForgetting(text: string): Promise<string> {
  // A factual recall excludes proposals, reports and unresolved questions by design. Correction
  // must be able to find those managed items too; this only lists candidates and never deletes one.
  const result = await retryRead((client) => client.call('recall', { query: text, memory_view: 'all' }));

  const hits: { slug: string; id: string; line: Line }[] = [];
  for (const card of result.results.filter((entry) => entry.type === 'page')) {
    for (const line of card.lines) {
      const memory = retainedMemoryQualification(line);
      const id = memory?.id ?? (memory === undefined ? line.fact : undefined);
      if (id && line.text.trim()) hits.push({ slug: card.slug, id, line });
    }
  }

  if (hits.length === 0) {
    const looksLikePage = text.includes('/') && !text.includes(' ');
    return looksLikePage
      ? `Nothing retractable matched \`${text}\`. To remove a whole page, use \`/delete ${text}\`.`
      : `Nothing retractable matched "${text}". Try \`/recall ${text}\` to see what memory holds.`;
  }

  const lines = [`🔍 Matches for "${text}" — \`/forget <id>\` removes one:`, ''];
  for (const hit of hits.slice(0, 8)) {
    lines.push(`\`${hit.id}\` — ${hit.line.text.trim().slice(0, 160)}`);
    lines.push(`   in \`${hit.slug}\``);
  }
  if (hits.length > 8) lines.push('', `… and ${hits.length - 8} more. Narrow the wording to see fewer.`);
  return lines.join('\n');
}

/**
 * Delete a whole page.
 *
 * Its own command, not a spelling of `/forget`. Removing one wrong sentence and removing a page and
 * everything on it are different intentions, and a user who means one and gets the other has no
 * warning until they read the reply.
 *
 * The page goes to trash, so this is reversible — by `/restore`, which is the command that knows
 * about pages, or by the `/undo` printed in the reply.
 */
async function deletePage(argument: string): Promise<string> {
  const slug = argument.trim().replace(/^\/+|\.md$/g, '');
  if (!slug)
    return 'Usage: `/delete <page>` — e.g. `/delete people/jane`. The page goes to trash and `/restore` brings it back.';
  if (looksLikeFactId(slug))
    return `\`${slug}\` is a fact id, not a page. Use \`/forget ${slug}\` to remove that one sentence.`;

  const result = (await withMemory((client) => client.call('forget', { slug }))) as {
    change_id?: string;
    trashed?: string;
  };

  // The slug the user typed, not `result.trashed` — that is the absolute path of the snapshot
  // inside memory's trash directory, so quoting it back produced a `/restore` naming a file the
  // command cannot look up and the user cannot have meant.
  const undoHint = result.change_id ? ` Undo with \`/undo ${result.change_id}\`` : '';
  return `🗑️ \`${slug}\` is in the trash — \`/restore ${slug}\` brings it back.${undoHint}`;
}

/**
 * What was deleted, and putting one back.
 *
 * `/undo` reverses *the last thing that happened*. That is a different question from "I deleted a
 * page a while ago and want it back": by then the delete is several changes down the journal, and
 * finding its id means reading a list of everything that has happened since. So this asks the
 * page-shaped question — with no argument it lists what has been deleted, and with a page it
 * reverses that page's most recent delete.
 *
 * Deletes are reversible because the page's bytes are held in memory's trash. Nothing prunes that
 * trash today, so an old delete is still reversible — but that is the current behaviour of a
 * retention setting that exists, not a promise, so the listing shows dates and lets the reader judge.
 */
async function restore(argument: string): Promise<string> {
  const wanted = argument.trim().replace(/^\/+|\.md$/g, '');

  // Deep enough to cover a page deleted a while ago, since that is exactly the case `/undo` cannot
  // reach. Deletes are rare next to writes, so most of this scan finds nothing and costs nothing.
  const changes = (await retryRead((client) => client.command('changes', { limit: 200 }))) as {
    id: string;
    at: string;
    summary: string;
    status: string;
    files?: { relPath: string; action: string }[];
  }[];

  const deletes = changes.filter(
    (change) => change.status === 'applied' && (change.files ?? []).some((file) => file.action === 'deleted'),
  );

  if (deletes.length === 0) return '🗑️ Nothing deleted recently.';

  if (!wanted) {
    const lines = ['🗑️ **Deleted recently**', ''];
    for (const change of deletes.slice(0, 15)) {
      const pages = (change.files ?? [])
        .filter((file) => file.action === 'deleted')
        .map((file) => file.relPath.replace(/\.md$/, ''));
      lines.push(`\`${pages.join('`, `') || change.summary}\` — ${change.at.slice(0, 10)}`);
    }
    lines.push('', 'Bring one back: `/restore <page>`');
    return lines.join('\n');
  }

  const match = deletes.find((change) =>
    (change.files ?? []).some((file) => file.action === 'deleted' && file.relPath.replace(/\.md$/, '') === wanted),
  );
  if (!match) return `No deleted page \`${wanted}\`. \`/restore\` with no argument lists what was deleted.`;

  const result = (await withMemory((client) => client.call('undo', { change_id: match.id }))) as {
    reversed?: string;
  };
  return `↩️ \`${wanted}\` is back — ${result.reversed ?? match.summary}.`;
}

/**
 * Reverse a change.
 *
 * With no id it takes the most recent one, because that is what "undo" means everywhere else and
 * because the alternative — asking the owner to copy an id out of a previous message — is a poor
 * answer to "that was wrong". Named ids still work and outlive the conversation.
 */
async function undo(argument: string): Promise<string> {
  let changeId = argument.trim();

  if (!changeId) {
    const changes = (await retryRead((client) => client.command('changes', { limit: 5 }))) as {
      id: string;
      summary: string;
      status: string;
    }[];
    const latest = changes.find((change) => change.status === 'applied');
    if (!latest) return 'Nothing to undo — memory has no changes on record.';
    changeId = latest.id;
  }

  const result = (await withMemory((client) => client.call('undo', { change_id: changeId }))) as {
    reversed?: string;
  };
  return `↩️ Undone — ${result.reversed ?? changeId}.`;
}

/**
 * Drop the YAML block a page opens with.
 *
 * `read` returns the file's lines, frontmatter included — correct for a caller that wants the file,
 * and wrong for a person who asked to read a page. Six lines of `type:` and `created_at:` before
 * the first sentence is the page's filing metadata, not its content, and on a phone it is most of
 * the screen.
 */
function stripFrontmatter(lines: Line[]): Line[] {
  if (lines[0]?.text.trim() !== '---') return lines;
  const close = lines.findIndex((line, index) => index > 0 && line.text.trim() === '---');
  // An unterminated block means the `---` was a horizontal rule, not frontmatter. Keep everything:
  // dropping the whole page because of a stray rule loses far more than it tidies.
  return close === -1 ? lines : lines.slice(close + 1);
}

/** Telegram refuses anything larger; a caption with no document reads as success. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_FILES = 10;

/**
 * Send the files attached to a page back out of memory.
 *
 * Getting a stored receipt or document scan back was the one thing the old command set could do
 * that the ops cannot: `read({document})` returns a document's *extracted text*, never its bytes,
 * so nothing on the wire carries the file itself.
 *
 * The bytes are reachable anyway, and not by going behind the service's back: the handshake
 * advertises `akno_path`, and every document's `rel_path` is relative to it. Luna and memory run
 * as the same user on the same Mac by design — that is why the door is a unix socket — so a path
 * the service hands over is a path this process may read. Nothing is assumed about the layout: no
 * directory is guessed, only joined to what was advertised, and the result is checked to be inside
 * it before anything is opened.
 */
async function download(argument: string, ctx: MemoryCommandContext): Promise<string | MemoryReply[]> {
  const slug = argument.trim().replace(/^\/+|\.md$/g, '');
  if (!slug) return 'Usage: `/download <page>` — e.g. `/download receipts/2031-04-02-cafe`.';

  const client = await memory();
  const result = (await retryRead((handle) => handle.call('read', { slug }))) as {
    page?: { slug: string; documents?: { rel_path?: string; label?: string; mime?: string }[] };
  };
  const page = result.page;
  if (!page) return notFound(slug);

  const documents = (page.documents ?? []).filter((doc) => doc.rel_path);
  if (documents.length === 0) return `📄 \`${page.slug}\` has no files attached.`;

  const root = path.resolve(client.hello.akno_path);
  const wanted = documents.slice(0, MAX_DOWNLOAD_FILES);
  const messageId = `mem-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rows: MemoryReply[] = [
    { text: `📎 ${wanted.length} file${wanted.length === 1 ? '' : 's'} on \`${page.slug}\`` },
  ];

  for (const doc of wanted) {
    const relPath = doc.rel_path!;
    const abs = path.resolve(root, relPath);
    // `rel_path` comes from memory's own index, but it is still a path being joined to a root and
    // then opened. A `..` in it would read a file outside the knowledge base entirely.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      log.warn('refusing a document path outside the knowledge base', { slug, relPath });
      continue;
    }

    const name = path.basename(abs);
    if (!isSafeAttachmentName(name)) {
      rows.push({ text: `⚠️ Skipped a file whose name cannot be sent safely: ${name}` });
      continue;
    }

    let bytes: number;
    try {
      bytes = fs.statSync(abs).size;
    } catch {
      rows.push({ text: `⚠️ \`${relPath}\` is indexed but missing on disk.` });
      continue;
    }
    if (bytes > MAX_FILE_BYTES) {
      rows.push({ text: `⚠️ ${name} is ${formatBytes(bytes)} — over the 50 MB limit, skipped.` });
      continue;
    }

    if (!stageOutboxFile(ctx, messageId, abs, name)) {
      rows.push({ text: `⚠️ Could not read ${name} out of memory.` });
      continue;
    }
    rows.push({
      text: `📎 ${name} · ${formatBytes(bytes)}${doc.label ? ` — ${doc.label}` : ''}`,
      files: [name],
      id: messageId,
    });
  }

  if (documents.length > wanted.length) {
    rows.push({ text: `… and ${documents.length - wanted.length} more file(s) on \`${page.slug}\`.` });
  }
  return rows;
}

/**
 * Copy one file into the outbox directory delivery reads from.
 *
 * Stat'ed after the copy because `readOutboxFiles` returns undefined when nothing landed, and the
 * host then delivers the caption with no document attached — a failure that reads as success.
 */
function stageOutboxFile(ctx: MemoryCommandContext, messageId: string, abs: string, name: string): boolean {
  const dir = path.join(sessionDir(ctx.agentGroupId, ctx.sessionId), 'outbox', messageId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    fs.copyFileSync(abs, target);
    return fs.statSync(target).isFile();
  } catch (err) {
    log.warn('could not stage a memory file for delivery', { name, err });
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function notFound(slug: string): string {
  const folder = slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : '';
  return `No page \`${slug}\` in memory. Try \`/list${folder ? ` ${folder}` : ''}\` or \`/recall ${slug.split('/').pop()}\`.`;
}
