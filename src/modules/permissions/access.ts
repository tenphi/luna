/**
 * Access control.
 *
 * Privilege is a property of a *person*, and people are declared in `config/local.jsonc`. An inbound
 * identity resolves to a configured user or to nobody; there is no third state and no runtime grant.
 *
 * This replaced two DB tables. `user_roles` held the single `owner` row and `agent_group_members`
 * held everyone else, both written by an approve-from-chat flow — so who could talk to the install
 * was three tables deep and invisible in the file the operator edits. The per-agent-group grain of
 * `agent_group_members` went with them: there is exactly one agent group in this product
 * (`getTheAgent`, `bootstrapSingleAgent`), so "member of *which* group" never had a second answer.
 *
 * Approver-picking (`pickApprover`, `pickApprovalDelivery`) lives in the approvals module — see
 * `src/modules/approvals/primitive.ts`.
 */
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import { resolveUserKey } from '../../users/binding.js';
import { ownerKey, rosterUser } from '../../users/roster.js';

export type AccessDecision =
  | { allowed: true; reason: 'owner' | 'member' }
  | { allowed: false; reason: 'unknown_user' | 'user_disabled' };

/**
 * Can this user interact with this agent group?
 *
 * `agentGroupId` is accepted and unused: the roster is install-wide. Kept in the signature because
 * it is the shape the router's gate hook passes, and because a future install with more than one
 * agent would need it back.
 */
export function canAccessAgentGroup(userId: string, _agentGroupId: string): AccessDecision {
  // Unconditional, and first. The local CLI identity is an owner by virtue of host access, on an
  // install that names nobody as much as on one that does. Resolving its key through the roster
  // instead would make the terminal stop working exactly when the roster is the broken thing — and
  // the terminal is how a broken roster gets fixed.
  if (userId === CLI_LOCAL_USER_ID) return { allowed: true, reason: 'owner' };

  const key = resolveUserKey(userId);
  if (!key) return { allowed: false, reason: 'unknown_user' };

  // A configured-but-disabled person is refused, and refused *distinguishably*: "we know who this is
  // and are not answering them" is a different fact from "we have no idea who this is", and only the
  // second is worth telling the owner about.
  if (!rosterUser(key)?.enabled) return { allowed: false, reason: 'user_disabled' };

  return key === ownerKey() ? { allowed: true, reason: 'owner' } : { allowed: true, reason: 'member' };
}
