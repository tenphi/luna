import { getDb } from '../../../db/connection.js';
import { deleteRecords, findRecord, insertRecord, pickRecord } from '../../../db/records.js';

export type PendingChannelApproval = {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  title: string;
  options_json: string;
};

export function createPendingChannelApproval(request: PendingChannelApproval): void {
  insertRecord(getDb(), 'pending_approvals', {
    ...request,
    approval_id: request.messaging_group_id,
    request_id: request.messaging_group_id,
    kind: 'channel',
    action: 'channel_registration',
    payload: '{}',
  });
}
export function getPendingChannelApproval(id: string): PendingChannelApproval | undefined {
  const found = findRecord(getDb(), 'pending_approvals', { approval_id: id, kind: 'channel' });
  return found
    ? (pickRecord(found as object, [
        'messaging_group_id',
        'agent_group_id',
        'original_message',
        'approver_user_id',
        'created_at',
        'title',
        'options_json',
      ]) as PendingChannelApproval)
    : undefined;
}
export const hasInFlightChannelApproval = (id: string): boolean =>
  findRecord(getDb(), 'pending_approvals', { messaging_group_id: id, kind: 'channel', status: 'pending' }) !==
  undefined;
export const deletePendingChannelApproval = (id: string): void =>
  deleteRecords(getDb(), 'pending_approvals', { approval_id: id, kind: 'channel' });
