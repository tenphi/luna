/**
 * Answering approvals from the terminal.
 *
 * This is the install's break-glass path: every other way to resolve a pending card goes through a
 * chat channel, so an install with no reachable owner had approvals it could see and not answer.
 * The tests that matter here are the two guards — host-only, and value inference per card kind —
 * because getting either wrong turns break-glass into privilege escalation.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, initializeCentralSchema } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';

vi.mock('../../container-runner.js', async () => {
  const { fakeContainers } = await import('../../../test/support/containers.js');
  return fakeContainers();
});

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
}));

import { dispatch } from '../dispatch.js';
import { registerApprovalHandler, registerDeclineHandler } from '../../modules/approvals/primitive.js';
import { handleApprovalsResponse } from '../../modules/approvals/response-handler.js';
import { registerResponseHandler } from '../../response-registry.js';
import './approvals.js';

// The response registry is module-global and append-only, so register once for the whole file
// rather than per test — a second registration would leave a duplicate handler behind.
registerResponseHandler(handleApprovalsResponse);

const approved: string[] = [];
const declined: string[] = [];
registerApprovalHandler('test_action', async ({ payload }) => {
  approved.push(String(payload.what));
});
registerDeclineHandler('test_action', async ({ payload }) => {
  declined.push(String(payload.what));
});

const now = () => new Date().toISOString();

function seedApproval(id: string, optionsJson = '[{"value":"approve"},{"value":"reject"}]'): void {
  createPendingApproval({
    approval_id: id,
    session_id: 'sess-1',
    request_id: id,
    action: 'test_action',
    payload: JSON.stringify({ what: id }),
    created_at: now(),
    title: 'Test approval',
    options_json: optionsJson,
  });
}

beforeEach(() => {
  approved.length = 0;
  declined.length = 0;
  const db = initTestDb();
  initializeCentralSchema(db);
  createAgentGroup({ id: 'ag-1', name: 'AG-1', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
});

describe('luna approvals approve|reject', () => {
  it('runs the registered handler and clears the row', async () => {
    seedApproval('appr-yes');

    const resp = await dispatch(
      { id: 'req-1', command: 'approvals-approve', args: { id: 'appr-yes' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { claimed: boolean; resolved: boolean; value: string } }).data;
    expect(data.claimed).toBe(true);
    expect(data.resolved).toBe(true);
    expect(data.value).toBe('approve');
    expect(approved).toEqual(['appr-yes']);
    expect(getPendingApproval('appr-yes')).toBeUndefined();
  });

  it('runs the decline handler on reject', async () => {
    seedApproval('appr-no');

    const resp = await dispatch(
      { id: 'req-2', command: 'approvals-reject', args: { id: 'appr-no' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(declined).toEqual(['appr-no']);
    expect(approved).toEqual([]);
    expect(getPendingApproval('appr-no')).toBeUndefined();
  });

  it('refuses an agent caller, so an agent cannot approve its own request', async () => {
    // The resource whitelist in dispatch.ts only bites at cliScope 'agent'; the install agent runs
    // at 'global'. Without this guard, `access: 'open'` would hand the agent its own approvals.
    seedApproval('appr-self');

    const resp = await dispatch(
      { id: 'req-3', command: 'approvals-approve', args: { id: 'appr-self' } },
      { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toContain('host terminal');
    expect(approved).toEqual([]);
    expect(getPendingApproval('appr-self')).toBeDefined();
  });

  it('takes the approve value from the card, not a hardcoded string', async () => {
    // A channel-registration card approves with `connect:<agentGroupId>`; 'approve' is not among its
    // options, so a hardcoded 'approve' would be refused by that handler.
    //
    // The row is seeded as `test_action` with channel-shaped options on purpose: this asserts the
    // inference in isolation. The action handler downstream sees a value that isn't 'approve' and
    // logs a rejection, which is right for *its* kind — hence only `value` is asserted here.
    seedApproval('appr-connect', '[{"value":"connect:ag-1"},{"value":"reject"}]');

    const resp = await dispatch(
      { id: 'req-4', command: 'approvals-approve', args: { id: 'appr-connect' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { value: string } }).data.value).toBe('connect:ag-1');
  });

  it('honors an explicit --value over the inferred one', async () => {
    seedApproval('appr-explicit', '[{"value":"connect:ag-1"},{"value":"reject"}]');

    const resp = await dispatch(
      { id: 'req-5', command: 'approvals-approve', args: { id: 'appr-explicit', value: 'connect:ag-other' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { value: string } }).data.value).toBe('connect:ag-other');
  });

  it('errors on an unknown id rather than reporting success', async () => {
    const resp = await dispatch(
      { id: 'req-6', command: 'approvals-approve', args: { id: 'appr-missing' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toContain('appr-missing');
  });

  it('errors when no id is passed', async () => {
    const resp = await dispatch({ id: 'req-7', command: 'approvals-approve', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { message: string } }).error.message).toContain('approval id');
  });
});
