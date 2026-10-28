import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, initTestDb } from '../../db/connection.js';
import { initializeCentralSchema } from '../../db/initialize.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { registerApprovalHandler, registerDeclineHandler } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';
const effects = vi.hoisted(() => ({ wake: vi.fn().mockResolvedValue(undefined), write: vi.fn() }));
vi.mock('../../container-runner.js', () => ({ wakeContainer: effects.wake }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: effects.write }));
const answer = {
  questionId: 'synthetic-request',
  value: 'approve',
  userId: 'telegram:ada',
  channelType: 'telegram',
  platformId: 'synthetic-chat',
  threadId: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  initializeCentralSchema(initTestDb());
  createAgentGroup({
    id: 'fixture-agent',
    name: 'Synthetic agent',
    agent_provider: null,
    created_at: '2027-01-01T00:00:00Z',
  });
  createSession({
    id: 'fixture-session',
    agent_group_id: 'fixture-agent',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2027-01-01T00:00:00Z',
  });
  createPendingApproval({
    approval_id: answer.questionId,
    request_id: answer.questionId,
    session_id: 'fixture-session',
    action: 'synthetic_action',
    payload: '{"fixture":true}',
    title: 'Synthetic approval',
    created_at: '2027-01-01T00:00:00Z',
    options_json: '[{"label":"Approve","value":"approve"},{"label":"Reject","value":"reject"}]',
  });
});
afterEach(() => closeDb());
it('claims an approval before awaiting its action, so a second click cannot apply it twice', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apply = vi.fn(async () => {
    await barrier;
  });
  registerApprovalHandler('synthetic_action', apply);
  const first = handleApprovalsResponse(answer);
  await handleApprovalsResponse(answer);
  expect(apply).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(getPendingApproval(answer.questionId)).toBeUndefined();
});
it('declines an option the card never offered', async () => {
  const apply = vi.fn();
  const decline = vi.fn();
  registerApprovalHandler('synthetic_action', apply);
  registerDeclineHandler('synthetic_action', decline);
  await handleApprovalsResponse({ ...answer, value: 'forged-option' });
  expect(apply).not.toHaveBeenCalled();
  expect(decline).toHaveBeenCalledTimes(1);
  expect(effects.write).toHaveBeenCalledTimes(1);
  expect(getPendingApproval(answer.questionId)).toBeUndefined();
});
