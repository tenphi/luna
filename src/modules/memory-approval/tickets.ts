/**
 * One-shot delegations for a memory proposal the owner handed to the agent.
 *
 * `approve` is deliberately absent from the agent's tool surface: memory refuses to file a claim on
 * an agent's word, and letting the agent answer its own proposal would give back exactly what the
 * refusal was protecting. But the owner picking "let me name it" on the card *is* the owner's word,
 * and the page they want frequently does not exist yet — so there is nothing on the card to press.
 *
 * A ticket is that permission, narrowed to the one proposal it was granted for and spent on first
 * use. The agent can ask which page and file it there; it cannot answer anything the owner did not
 * hand over, and it cannot answer the same thing twice.
 *
 * Deliberately in memory only. A ticket outliving a host restart would be a standing permission
 * nobody remembers granting, and the proposal stays pending, so the next digest cards it again.
 */
import { log } from '../../log.js';

/** Long enough to finish the exchange it belongs to, short enough not to become standing. */
const TICKET_TTL_MS = 60 * 60 * 1000;

/**
 * Keyed by proposal id, scoped to the agent **group**.
 *
 * Not the session: a host-MCP caller's session id is a claim it makes in a header, while the bearer
 * token authenticates the group — so the group is the only boundary a ticket can actually rest on
 * (see `src/host-mcp/caller-context.ts`).
 */
const tickets = new Map<string, { agentGroupId: string; expiresAt: number }>();

function sweepExpired(now: number): void {
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(id);
  }
}

/** Record that the owner asked to name the destination for this proposal themselves. */
export function grantProposalTicket(proposalId: string, agentGroupId: string): void {
  const now = Date.now();
  sweepExpired(now);
  tickets.set(proposalId, { agentGroupId, expiresAt: now + TICKET_TTL_MS });
  log.info('Memory proposal delegated to the agent', { proposalId, agentGroupId });
}

/**
 * Spend the ticket for `proposalId`, or return false when there is none.
 *
 * Consumed before the work runs, not after: a second call arriving while the first is in flight
 * would otherwise file the held claim twice, which is the duplicate-write the memory client's
 * no-retry rule exists to avoid.
 */
export function spendProposalTicket(proposalId: string, agentGroupId: string): boolean {
  const now = Date.now();
  sweepExpired(now);
  const ticket = tickets.get(proposalId);
  if (!ticket) return false;
  // The group the card was answered for, so one install's delegation is not spendable by another
  // agent group that happens to know the id.
  if (ticket.agentGroupId !== agentGroupId) return false;
  tickets.delete(proposalId);
  return true;
}

/** Test seam — no production caller should need to forget a ticket without spending it. */
export function clearProposalTickets(): void {
  tickets.clear();
}
