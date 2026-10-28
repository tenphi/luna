/**
 * Memory-approval module — owner-answered memory proposals, from chat.
 *
 * Memory refuses to guess where a claim goes when nothing scores high enough and it cannot name a
 * page for it either. That comes back as `requires_approval` and waits. Placement is Luna's job:
 * the sweep hands the proposal back to the agent, which inspects the structure and chooses.
 *
 * **A new folder is no longer one of these.** It used to be: an agent naming a folder nothing had
 * described produced a proposal and a yes/no card. The owner is not asked any more — the agent
 * declares the folder itself, with a description of what belongs in it — so the only proposals
 * reaching here are about *where a claim goes*, which is a question only they can answer.
 *
 * Factual conflicts remain owner decisions and still use the approvals module.
 */
import { registerApprovalHandler, registerDeclineHandler } from '../approvals/index.js';
import { applyMemoryProposal, declineMemoryProposal } from './apply.js';
import { MEMORY_PROPOSAL_ACTION } from './request.js';

export {
  MEMORY_PROPOSAL_ACTION,
  delegateMemoryProposal,
  handlePendingProposals,
  requestMemoryProposalApproval,
} from './request.js';
export type { MemoryProposal } from './request.js';
export { spendProposalTicket } from './tickets.js';

registerApprovalHandler(MEMORY_PROPOSAL_ACTION, applyMemoryProposal);
registerDeclineHandler(MEMORY_PROPOSAL_ACTION, declineMemoryProposal);
