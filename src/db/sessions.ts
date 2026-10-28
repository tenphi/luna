import type { PendingApproval, PendingQuestion, Session } from '../types.js';
import { getDb } from './connection.js';
import { deleteRecords, findRecord, findRecords, insertRecord, pickRecord, updateRecords } from './records.js';

const sessionKeys =
  'id agent_group_id messaging_group_id thread_id agent_provider status container_status last_active created_at ephemeral'.split(
    ' ',
  );
export function createSession(session: Session): void {
  insertRecord(getDb(), 'sessions', { ...pickRecord(session, sessionKeys), ephemeral: session.ephemeral ?? 0 });
}
export const getSession = (id: string): Session | undefined => findRecord(getDb(), 'sessions', { id });
export const findSession = (group: string, thread: string | null): Session | undefined =>
  findRecord(getDb(), 'sessions', { messaging_group_id: group, thread_id: thread || null, status: 'active' });
export const findSessionForAgent = (agent: string, group: string, thread: string | null): Session | undefined =>
  findRecord(getDb(), 'sessions', {
    agent_group_id: agent,
    messaging_group_id: group,
    thread_id: thread || null,
    status: 'active',
  });
export const findSessionByAgentGroup = (agent: string): Session | undefined =>
  findRecords<Session>(
    getDb(),
    'sessions',
    { agent_group_id: agent, status: 'active' },
    { column: 'created_at', descending: true },
    1,
  )[0];
export const getSessionsByAgentGroup = (agent: string): Session[] =>
  findRecords(getDb(), 'sessions', { agent_group_id: agent });
export const getActiveSessions = (): Session[] => findRecords(getDb(), 'sessions', { status: 'active' });
export const getStoppedEphemeralSessions = (): Session[] =>
  findRecords(getDb(), 'sessions', { ephemeral: 1, container_status: 'stopped' });
export const resetAllContainerStatus = (): number =>
  updateRecords(getDb(), 'sessions', { container_status: 'stopped' }, 'container_status<>?', ['stopped']);
export function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): void {
  updateRecords(
    getDb(),
    'sessions',
    pickRecord(updates, ['status', 'container_status', 'last_active', 'agent_provider']),
    'id=?',
    [id],
  );
}
export const deleteSession = (id: string): void => deleteRecords(getDb(), 'sessions', { id });

export function createPendingQuestion(question: PendingQuestion): boolean {
  const { options, ...data } = question;
  return insertRecord(getDb(), 'pending_questions', { ...data, options_json: JSON.stringify(options) }, true) > 0;
}
export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  const stored = findRecord<Omit<PendingQuestion, 'options'> & { options_json: string }>(getDb(), 'pending_questions', {
    question_id: questionId,
  });
  if (!stored) return undefined;
  const { options_json: encoded, ...fields } = stored;
  return Object.assign(fields, { options: JSON.parse(encoded) });
}
export const deletePendingQuestion = (id: string): void =>
  deleteRecords(getDb(), 'pending_questions', { question_id: id });

type ApprovalInput = Partial<PendingApproval> &
  Pick<PendingApproval, 'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'>;
const approvalKeys =
  'approval_id session_id request_id action payload created_at agent_group_id channel_type platform_id platform_message_id expires_at status title options_json'.split(
    ' ',
  );
export function createPendingApproval(approval: ApprovalInput): boolean {
  const defaults = {
    session_id: null,
    agent_group_id: null,
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
  };
  return insertRecord(getDb(), 'pending_approvals', { ...defaults, ...pickRecord(approval, approvalKeys) }, true) > 0;
}
export const getPendingApproval = (id: string): PendingApproval | undefined =>
  findRecord(getDb(), 'pending_approvals', { approval_id: id });
export const getPendingApprovalsByAction = (action: string): PendingApproval[] =>
  findRecords(getDb(), 'pending_approvals', { action });
export function updatePendingApprovalStatus(id: string, status: PendingApproval['status']): void {
  updateRecords(getDb(), 'pending_approvals', { status }, 'approval_id=?', [id]);
}
export const deletePendingApproval = (id: string): void =>
  deleteRecords(getDb(), 'pending_approvals', { approval_id: id });

export function getAskQuestionRender(
  id: string,
): { title: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined {
  const question = getPendingQuestion(id);
  if (question) return { title: question.title, options: question.options };
  const approval = getPendingApproval(id);
  return approval?.title ? { title: approval.title, options: JSON.parse(approval.options_json) } : undefined;
}
