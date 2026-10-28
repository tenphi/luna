import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler, getDeclineHandler } from './primitive.js';

function offered(serialized: string, value: string): boolean {
  try {
    const choices: unknown = JSON.parse(serialized);
    if (Array.isArray(choices) && choices.length) return choices.some((choice) => choice?.value === value);
  } catch {
    /* Legacy cards without readable options offer only approve/reject. */
  }
  return value === 'approve';
}

export async function handleApprovalsResponse(answer: ResponsePayload): Promise<boolean> {
  if (resolveOneCLIApproval(answer.questionId, answer.value)) return true;
  const request = getPendingApproval(answer.questionId);
  if (!request || (request.kind ?? 'action') !== 'action') return false;
  if (request.action === ONECLI_ACTION || !request.session_id) {
    deletePendingApproval(answer.questionId);
    return true;
  }
  const session = getSession(request.session_id);
  if (!session) {
    deletePendingApproval(answer.questionId);
    return true;
  }
  const approved = answer.value !== 'reject' && offered(request.options_json, answer.value);
  // Claim synchronously before any handler awaits, so another click cannot apply the same action.
  if (
    !getDb()
      .prepare("UPDATE pending_approvals SET status=? WHERE approval_id=? AND status='pending'")
      .run(approved ? 'approved' : 'rejected', request.approval_id).changes
  )
    return true;
  const notice = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${randomUUID()}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      channelType: 'agent',
      platformId: session.agent_group_id,
      threadId: null,
      content: JSON.stringify({ sender: 'system', senderId: 'system', text }),
    });
  };
  try {
    const context = { session, payload: JSON.parse(request.payload), userId: answer.userId ?? '' };
    if (!approved) {
      notice(`Your ${request.action} request was rejected by admin.`);
      await getDeclineHandler(request.action)?.(context);
    } else {
      const handler = getApprovalHandler(request.action);
      if (handler) await handler({ ...context, selectedOption: answer.value, notify: notice });
      else notice(`Your ${request.action} was approved, but no handler is installed to apply it.`);
    }
  } catch (error) {
    log.error('Approval action failed', { id: request.approval_id, error });
    if (approved)
      notice(
        `Your ${request.action} was approved, but applying it failed: ${error instanceof Error ? error.message : String(error)}.`,
      );
  } finally {
    deletePendingApproval(answer.questionId);
    await wakeContainer(session);
  }
  return true;
}
