/**
 * Applying the owner's answer to a memory proposal.
 *
 * Answering is a write: memory has been holding the claim, and `approve` files it. So this runs
 * through `withMemory` rather than `retryRead` — a connection that dies mid-approve says nothing
 * about whether the claim landed, and repeating it is how a held claim gets written twice.
 */
import { withMemory } from '../../memory/client.js';
import { log } from '../../log.js';
import type { ApprovalHandlerContext, DeclineHandlerContext } from '../approvals/index.js';
import { NAME_IT_VALUE, pageFromOptionValue } from './request.js';
import { grantProposalTicket } from './tickets.js';

function proposalIdFrom(payload: Record<string, unknown>): string {
  return typeof payload.proposalId === 'string' ? payload.proposalId : '';
}

export async function applyMemoryProposal(ctx: ApprovalHandlerContext): Promise<void> {
  const proposalId = proposalIdFrom(ctx.payload);
  if (!proposalId) {
    ctx.notify('A memory proposal was approved but the card carried no proposal id — nothing was filed.');
    return;
  }

  // "Somewhere else" is not an answer, it is the owner taking the question into the conversation.
  // The proposal stays pending and the agent gets a one-shot permission to finish it.
  if (ctx.selectedOption === NAME_IT_VALUE) {
    grantProposalTicket(proposalId, ctx.session.agent_group_id);
    const subject = typeof ctx.payload.subject === 'string' && ctx.payload.subject ? ` ("${ctx.payload.subject}")` : '';
    ctx.notify(
      `The owner wants to name the page for memory proposal ${proposalId}${subject} themselves. ` +
        `Ask them which page it should go on — a page that does not exist yet is a normal answer, and ` +
        `they may want a new one. When they tell you, call memory_answer_proposal ` +
        `{proposal_id: "${proposalId}", slug: "<page>"}. You may do this once, for this proposal only. ` +
        `Do not guess a page and do not file it without their answer.`,
    );
    return;
  }

  const slug = pageFromOptionValue(ctx.selectedOption);
  // No page on the option means a card without page buttons — approving replays the payload memory
  // is already holding, which is what it proposed in the first place.
  const args = slug ? { proposal_id: proposalId, slug } : { proposal_id: proposalId };

  try {
    await withMemory((client) => client.command('approve', args));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Memory proposal approval failed', { proposalId, slug, err });
    ctx.notify(`Filing memory proposal ${proposalId}${slug ? ` on ${slug}` : ''} failed: ${message}`);
    return;
  }

  log.info('Memory proposal approved', { proposalId, slug, userId: ctx.userId });
  ctx.notify(
    slug
      ? `The owner filed memory proposal ${proposalId} on \`${slug}\`. It is written — do not write it again.`
      : `The owner approved memory proposal ${proposalId}. It is written — do not write it again.`,
  );
}

export async function declineMemoryProposal(ctx: DeclineHandlerContext): Promise<void> {
  const proposalId = proposalIdFrom(ctx.payload);
  if (!proposalId) return;
  try {
    // Memory remembers a refusal, so the same claim coming round again gets the answer rather than
    // asking a second time.
    await withMemory((client) => client.command('decline', { proposal_id: proposalId }));
    log.info('Memory proposal declined', { proposalId, userId: ctx.userId });
  } catch (err) {
    log.error('Memory proposal decline failed', { proposalId, err });
  }
}
