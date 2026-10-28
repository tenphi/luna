import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import { ownerIdentities } from '../../users/binding.js';
import { ensureUserDm } from '../permissions/user-dm.js';

export type ApprovalHandlerContext = {
  session: Session;
  payload: Record<string, unknown>;
  userId: string;
  selectedOption: string;
  notify: (text: string) => void;
};
export type DeclineHandlerContext = Pick<ApprovalHandlerContext, 'session' | 'payload' | 'userId'>;
export type ApprovalHandler = (context: ApprovalHandlerContext) => Promise<void>;
export type DeclineHandler = (context: DeclineHandlerContext) => Promise<void>;
export type RequestApprovalOptions = {
  session: Session;
  agentName: string;
  action: string;
  payload: Record<string, unknown>;
  title: string;
  question: string;
  options?: RawOption[];
};
const accepted: Record<string, ApprovalHandler> = Object.create(null);
const declined: Record<string, DeclineHandler> = Object.create(null);
export const getApprovalHandler = (action: string): ApprovalHandler | undefined => accepted[action];
export const getDeclineHandler = (action: string): DeclineHandler | undefined => declined[action];
export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  accepted[action] = handler;
}
export function registerDeclineHandler(action: string, handler: DeclineHandler): void {
  declined[action] = handler;
}

export function pickApprover(): string[] {
  return [...new Set(ownerIdentities().filter((identity) => identity !== CLI_LOCAL_USER_ID)), CLI_LOCAL_USER_ID];
}
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  const sameChannel = (identity: string): boolean =>
    Boolean(originChannelType) && identity.split(':', 1)[0] === originChannelType;
  const ordered = [...approvers.filter(sameChannel), ...approvers.filter((identity) => !sameChannel(identity))];
  for (const userId of new Set(ordered)) {
    const messagingGroup = await ensureUserDm(userId);
    if (messagingGroup) return { userId, messagingGroup };
  }
  return null;
}

export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    kind: 'chat',
    channelType: 'agent',
    platformId: session.agent_group_id,
    threadId: null,
    content: JSON.stringify({ sender: 'system', senderId: 'system', text }),
  });
  const current = getSession(session.id);
  if (current)
    void wakeContainer(current).catch((error) =>
      log.error('Could not wake the session for an approval notice', { error }),
    );
}

/** Persist first: a card is an optional transport, while the CLI can always answer the ledger. */
export async function requestApproval(request: RequestApprovalOptions): Promise<void> {
  const id = `appr-${randomBytes(8).toString('base64url')}`;
  const options = request.options?.length
    ? request.options
    : [
        { label: 'Approve', value: 'approve', selectedLabel: '✅ Approved' },
        { label: 'Reject', value: 'reject', selectedLabel: '❌ Rejected' },
      ];
  createPendingApproval({
    approval_id: id,
    request_id: id,
    session_id: request.session.id,
    action: request.action,
    payload: JSON.stringify(request.payload),
    created_at: new Date().toISOString(),
    title: request.title,
    options_json: JSON.stringify(normalizeOptions(options)),
  });
  const origin = request.session.messaging_group_id
    ? getMessagingGroup(request.session.messaging_group_id)?.channel_type
    : undefined;
  const target = await pickApprovalDelivery(pickApprover(), origin ?? '');
  const adapter = getDeliveryAdapter();
  if (target && target.userId !== CLI_LOCAL_USER_ID && adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: id,
          title: request.title,
          question: request.question,
          options,
        }),
      );
      return;
    } catch (error) {
      log.warn('Approval card delivery failed; the request remains queued', { id, error });
    }
  }
  notifyAgent(
    request.session,
    `${request.action} is waiting for approval, but no owner could be reached to ask. It can be answered on the host with \`luna approvals approve ${id}\`.`,
  );
}
