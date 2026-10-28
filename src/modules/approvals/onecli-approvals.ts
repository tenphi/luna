import { randomBytes } from 'node:crypto';
import { OneCLI, type ApprovalRequest, type ManualApprovalHandle } from '@onecli-sh/sdk';
import { pickApprovalDelivery, pickApprover } from './primitive.js';
import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApprovalsByAction,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import type { PendingApproval } from '../../types.js';

export const ONECLI_ACTION = 'onecli_credential';
type Decision = 'approve' | 'deny';
type Waiting = { decide: (decision: Decision) => void; timer: NodeJS.Timeout };
let registration: ManualApprovalHandle | undefined;
let delivery: ChannelDeliveryAdapter | undefined;
let generation = 0;
const requests = new Map<string, Waiting>();

export function resolveOneCLIApproval(id: string, option: string): boolean {
  const waiting = requests.get(id);
  if (!waiting) return false;
  requests.delete(id);
  clearTimeout(waiting.timer);
  try {
    deletePendingApproval(id);
  } catch (error) {
    log.warn('Credential approval cleanup failed', { error });
  } finally {
    waiting.decide(option === 'approve' ? 'approve' : 'deny');
  }
  return true;
}

async function editExpired(row: PendingApproval, reason: string): Promise<void> {
  if (!delivery || !row.channel_type || !row.platform_id || !row.platform_message_id) return;
  try {
    await delivery.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: `Expired (${reason})`,
      }),
    );
  } catch (error) {
    log.warn('Could not update an expired credential card', { error });
  }
}
async function expire(id: string): Promise<void> {
  const row = getPendingApprovalsByAction(ONECLI_ACTION).find((request) => request.approval_id === id);
  if (row) {
    updatePendingApprovalStatus(id, 'expired');
    await editExpired(row, 'no response');
    deletePendingApproval(id);
  }
}
async function discardPreviousRequests(): Promise<void> {
  const stale = getPendingApprovalsByAction(ONECLI_ACTION);
  for (const row of stale) {
    await editExpired(row, 'host restarted');
    deletePendingApproval(row.approval_id);
  }
}

async function ask(request: ApprovalRequest): Promise<Decision> {
  const expires = Date.parse(request.expiresAt);
  const adapter = delivery;
  const epoch = generation;
  if (!adapter || !Number.isFinite(expires) || expires <= Date.now()) return 'deny';
  const target = await pickApprovalDelivery(pickApprover(), '');
  if (!target || epoch !== generation || adapter !== delivery || expires <= Date.now()) return 'deny';
  const id = `oa-${randomBytes(6).toString('base64url')}`;
  const source = request.agent.externalId ? getAgentGroup(request.agent.externalId) : undefined;
  const options = [
    { label: 'Approve', value: 'approve', selectedLabel: '✅ Approved' },
    { label: 'Reject', value: 'reject', selectedLabel: '❌ Rejected' },
  ];
  const details = {
    oneCliRequestId: request.id,
    method: request.method,
    host: request.host,
    path: request.path,
    bodyPreview: request.bodyPreview,
    agent: request.agent,
    approver: target.userId,
  };
  createPendingApproval({
    approval_id: id,
    request_id: request.id,
    action: ONECLI_ACTION,
    session_id: null,
    payload: JSON.stringify(details),
    created_at: new Date().toISOString(),
    expires_at: request.expiresAt,
    agent_group_id: source?.id ?? null,
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    platform_message_id: null,
    title: 'Credentials Request',
    options_json: JSON.stringify(options),
  });
  const answer = new Promise<Decision>((decide) => {
    const timer = setTimeout(
      () => {
        const waiting = requests.get(id);
        if (!waiting) return;
        requests.delete(id);
        waiting.decide('deny');
        void expire(id).catch((error) => log.error('Credential expiry cleanup failed', { error }));
      },
      Math.max(1, expires - Date.now() - 1000),
    );
    timer.unref();
    requests.set(id, { decide, timer });
  });
  if (target.userId !== CLI_LOCAL_USER_ID) {
    const body = request.bodyPreview ? `\nBody preview:\n${request.bodyPreview}` : '';
    try {
      const message = await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: id,
          title: 'Credentials Request',
          options,
          question: `Agent: ${source?.name ?? request.agent.name}\n${request.method} ${request.host}${request.path}${body}`,
        }),
      );
      if (message && requests.has(id)) {
        // A fast answer may already have consumed the row while delivery was in flight.
        getDb().prepare('UPDATE pending_approvals SET platform_message_id=? WHERE approval_id=?').run(message, id);
      }
    } catch (error) {
      log.warn('Credential approval delivery failed', { error });
      resolveOneCLIApproval(id, 'reject');
    }
  }
  return answer;
}

export function startOneCLIApprovalHandler(adapter: ChannelDeliveryAdapter): void {
  if (registration || !ONECLI_URL) return;
  generation++;
  delivery = adapter;
  void discardPreviousRequests().catch((error) => log.error('Could not clear stale credential approvals', { error }));
  registration = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY }).configureManualApproval(async (request) => {
    try {
      return await ask(request);
    } catch (error) {
      log.error('Credential approval failed closed', { error });
      return 'deny';
    }
  });
}
export function stopOneCLIApprovalHandler(): void {
  generation++;
  registration?.stop();
  registration = undefined;
  for (const id of requests.keys()) resolveOneCLIApproval(id, 'reject');
  delivery = undefined;
}
