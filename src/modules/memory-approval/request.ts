/** Memory proposals: autonomous placement, with owner approval retained only for conflicts. */
import type { RawOption } from '../../channels/ask-question.js';
import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { retryRead } from '../../memory/client.js';
import { openSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';

export const MEMORY_PROPOSAL_ACTION = 'memory_proposal';

/** Button value that hands the choice to the agent instead of answering it here. */
export const NAME_IT_VALUE = 'name_it';
/** Prefix marking a button whose value carries the page to file the claim on. */
export const PAGE_VALUE_PREFIX = 'page:';

export interface MemoryProposal {
  id: string;
  /** `route`, or `conflict` when two live claims disagree. Folders are no longer asked about. */
  kind?: string;
  /** Why memory would not file it — shown to the owner as the reason they are being asked. */
  reason: string;
  /** What the claim is about, when memory named it. */
  subject?: string;
  /** Pages that could actually receive the write, closest first. */
  nearest: string[];
}

/** The page a `page:` button was carrying, or null for any other option value. */
export function pageFromOptionValue(value: string): string | null {
  if (!value.startsWith(PAGE_VALUE_PREFIX)) return null;
  const slug = value.slice(PAGE_VALUE_PREFIX.length).trim();
  return slug || null;
}

/**
 * Telegram truncates a long button label, and a deep slug is mostly parent folders. Keep the tail,
 * which is the part that distinguishes two candidates from each other.
 */
export function shortenSlug(slug: string, max = 40): string {
  if (slug.length <= max) return slug;
  const parts = slug.split('/');
  let label = parts[parts.length - 1] ?? slug;
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `${parts[i]}/${label}`;
    if (candidate.length + 1 > max) break;
    label = candidate;
  }
  return `…/${label}`;
}

function buildOptions(proposal: MemoryProposal): RawOption[] | undefined {
  const options: RawOption[] = [];
  for (const slug of proposal.nearest) {
    if (!slug.trim()) continue;
    options.push({
      label: shortenSlug(slug),
      selectedLabel: `✅ ${shortenSlug(slug)}`,
      value: `${PAGE_VALUE_PREFIX}${slug}`,
    });
  }
  options.push({ label: 'Somewhere else…', selectedLabel: '✍️ Naming it', value: NAME_IT_VALUE });
  options.push({ label: 'Drop it', selectedLabel: '❌ Dropped', value: 'reject' });
  return options;
}

function buildQuestion(proposal: MemoryProposal): string {
  const lines: string[] = [];
  if (proposal.subject) lines.push(`🧠 **${proposal.subject}**`);
  lines.push(proposal.reason);
  lines.push(proposal.kind === 'conflict' ? '\nWhich value is current?' : '\nWhich page should it go on?');
  return lines.join('\n');
}

/** True when this proposal already has a card the owner has not answered. */
export function alreadyCarded(proposalId: string): boolean {
  return getPendingApprovalsByAction(MEMORY_PROPOSAL_ACTION).some((row) => {
    try {
      return (JSON.parse(row.payload) as { proposalId?: string }).proposalId === proposalId;
    } catch {
      return false;
    }
  });
}

/**
 * Send the owner a card for one proposal, unless one is already waiting.
 *
 * Called from the post-turn sweep, so a proposal the digest just raised is asked about while the
 * conversation it came from is still the thing the owner has in mind.
 */
export async function requestMemoryProposalApproval(proposal: MemoryProposal, session: Session): Promise<void> {
  if (alreadyCarded(proposal.id)) return;
  const agentGroup = getAgentGroup(session.agent_group_id);
  await requestApproval({
    session,
    agentName: agentGroup?.name ?? 'Luna',
    action: MEMORY_PROPOSAL_ACTION,
    payload: {
      proposalId: proposal.id,
      kind: proposal.kind ?? 'route',
      subject: proposal.subject ?? '',
      nearest: proposal.nearest,
    },
    title: proposal.kind === 'conflict' ? 'Memory conflict' : 'Where does this go?',
    question: buildQuestion(proposal),
    options: buildOptions(proposal),
  });
}

function delegationMessageId(proposalId: string): string {
  return `memory-place-${proposalId}`;
}

/** True once this session has been asked to place the proposal, even if that turn has completed. */
export function alreadyDelegated(proposalId: string, session: Session): boolean {
  const db = openSession(session.agent_group_id, session.id);
  try {
    return Boolean(db.prepare('SELECT 1 FROM messages_in WHERE id = ? LIMIT 1').get(delegationMessageId(proposalId)));
  } finally {
    db.close();
  }
}

/**
 * Hand a routing decision back to the agent instead of asking the owner with a card.
 *
 * The deterministic inbound id makes this durable across host restarts: a pending proposal is
 * delegated once, while the normal message retry path handles a turn that dies before completing.
 */
export async function delegateMemoryProposal(proposal: MemoryProposal, session: Session): Promise<void> {
  if (alreadyDelegated(proposal.id, session)) return;

  const destination = proposal.kind === 'ingest' ? 'folder for this file' : 'page for this claim';
  const nearest = proposal.nearest.length > 0 ? `\nMemory's nearest candidates: ${proposal.nearest.join(', ')}` : '';
  const subject = proposal.subject ? `\nSubject: ${proposal.subject}` : '';
  writeSessionMessage(session.agent_group_id, session.id, {
    id: delegationMessageId(proposal.id),
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      sender: 'system',
      senderId: 'system',
      text:
        `Internal memory placement: proposal ${proposal.id} needs a ${destination}.` +
        subject +
        `\nReason: ${proposal.reason}` +
        nearest +
        '\nDecide the best destination yourself. Inspect memory structure or recall context if useful; ' +
        'prefer an existing home, and declare a genuinely new folder yourself when needed. Then call ' +
        `memory_answer_proposal {proposal_id: "${proposal.id}", slug: "<destination>"}. ` +
        'Do not ask the owner where it goes and do not send a user-facing reply unless something blocks completion.',
    }),
  });

  const fresh = getSession(session.id);
  if (fresh) await wakeContainer(fresh);
  log.info('Memory placement delegated to the agent', { proposalId: proposal.id, kind: proposal.kind ?? 'route' });
}

/** One row of memory's `proposals` command. `nearest` arrives as a JSON-encoded string. */
interface ProposalRow {
  id?: unknown;
  kind?: unknown;
  reason?: unknown;
  subject?: unknown;
  nearest?: unknown;
  status?: unknown;
}

/** Placement belongs to the agent; only choosing which conflicting fact is current needs a person. */
export function proposalNeedsOwner(kind: string | undefined): boolean {
  return kind === 'conflict';
}

function parseNearest(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function toProposal(row: ProposalRow): MemoryProposal | null {
  if (typeof row.id !== 'string' || !row.id) return null;
  if (typeof row.status === 'string' && row.status !== 'pending') return null;
  return {
    id: row.id,
    kind: typeof row.kind === 'string' ? row.kind : undefined,
    reason: typeof row.reason === 'string' ? row.reason : 'Memory is holding this and wants you to decide.',
    subject: typeof row.subject === 'string' ? row.subject : undefined,
    nearest: parseNearest(row.nearest),
  };
}

/**
 * Resolve placement proposals through the agent; reserve owner approval for factual conflicts.
 *
 * Asking memory rather than reading only the digest's `pending` list also catches a foreground
 * ingest the agent left unresolved. Placement is delegated once per session with a durable message
 * id. A conflict still belongs to the owner because choosing which fact is current is not filing.
 */
export async function handlePendingProposals(session: Session): Promise<void> {
  let rows: ProposalRow[];
  try {
    rows = (await retryRead((client) => client.command('proposals'))) as ProposalRow[];
  } catch (err) {
    // Memory being unreachable is not this sweep's problem to solve; the next turn tries again.
    log.warn('Could not list pending memory proposals', { err });
    return;
  }
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    const proposal = toProposal(row);
    if (!proposal) continue;
    try {
      if (proposalNeedsOwner(proposal.kind)) await requestMemoryProposalApproval(proposal, session);
      else await delegateMemoryProposal(proposal, session);
    } catch (err) {
      // One proposal must not cost the others.
      log.error('Handling memory proposal failed', { proposalId: proposal.id, err });
    }
  }
}
