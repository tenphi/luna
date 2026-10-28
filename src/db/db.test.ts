import { afterEach, beforeEach, expect, it, describe } from 'vitest';
import * as store from './index.js';
import { getDestinations } from '../modules/agent-to-agent/db/agent-destinations.js';
import { countOpenReports, createReport, getReport, listReports, resolveReport } from './reports.js';

const now = (): string => '2031-04-02T10:00:00.000Z';
const agent = (id: string) => ({ id, name: `Fixture ${id}`, agent_provider: null, created_at: now() });
const channel = (id: string, address = id) => ({
  id,
  name: 'Synthetic conversation',
  channel_type: 'telegram',
  platform_id: address,
  is_group: 0,
  created_at: now(),
});
const wiring = (id: string, messaging: string, target: string, priority = 0) => ({
  id,
  messaging_group_id: messaging,
  agent_group_id: target,
  created_at: now(),
  priority,
  engage_mode: 'pattern' as const,
  engage_pattern: '.',
  ignored_message_policy: 'drop' as const,
  session_mode: 'shared' as const,
});
beforeEach(() => store.initializeCentralSchema(store.initTestDb()));
afterEach(() => store.closeDb());

it('keeps CRUD identity stable and preserves a partial update’s unspecified fields', () => {
  store.createAgentGroup(agent('editable'));
  store.createAgentGroup(agent('other'));
  store.updateAgentGroup('editable', { name: 'Updated fixture' });
  expect(store.getAgentGroup('editable')).toMatchObject({
    name: 'Updated fixture',
    created_at: now(),
    agent_provider: null,
  });
  expect(store.getAllAgentGroups()).toHaveLength(2);
  store.deleteAgentGroup('other');
  expect(store.getAgentGroup('other')).toBeUndefined();
  const saved = channel('editable-chat');
  store.createMessagingGroup(saved);
  expect(store.getMessagingGroupByPlatform(saved.channel_type, saved.platform_id)?.id).toBe(saved.id);
  expect(() => store.createMessagingGroup(channel('duplicate', saved.platform_id))).toThrow();
  store.updateMessagingGroup(saved.id, { name: 'New title' });
  expect(store.getMessagingGroup(saved.id)?.name).toBe('New title');
  store.deleteMessagingGroup(saved.id);
  expect(store.getMessagingGroup(saved.id)).toBeUndefined();
});
it('wires agents in priority order, creates delivery permissions, and rolls back invalid references', () => {
  for (const id of ['first', 'second']) store.createAgentGroup(agent(id));
  store.createMessagingGroup(channel('room'));
  store.createMessagingGroupAgent(wiring('lower', 'room', 'first', 2));
  store.createMessagingGroupAgent(wiring('higher', 'room', 'second', 9));
  expect(store.getMessagingGroupAgents('room').map((row) => row.id)).toEqual(['higher', 'lower']);
  expect(getDestinations('first').map((row) => row.target_id)).toEqual(['room']);
  expect(() => store.createMessagingGroupAgent(wiring('duplicate', 'room', 'first'))).toThrow();
  expect(() => store.createMessagingGroupAgent(wiring('invalid', 'room', 'absent'))).toThrow();
  expect(store.getMessagingGroupAgent('invalid')).toBeUndefined();
  store.updateMessagingGroupAgent('lower', { priority: 10 });
  expect(store.getMessagingGroupAgents('room')[0].id).toBe('lower');
  store.deleteMessagingGroupAgent('higher');
  expect(store.getMessagingGroupAgent('higher')).toBeUndefined();
});
it('assigns distinct destination names to similarly named conversations and does not duplicate re-wiring', () => {
  store.createAgentGroup(agent('single'));
  for (const id of ['one', 'two']) {
    store.createMessagingGroup(channel(id));
    store.createMessagingGroupAgent(wiring(id, id, 'single'));
  }
  const original = getDestinations('single');
  expect(new Set(original.map((row) => row.local_name)).size).toBe(2);
  store.deleteMessagingGroupAgent('one');
  store.createMessagingGroupAgent(wiring('replacement', 'one', 'single'));
  expect(getDestinations('single')).toHaveLength(2);
});
it('selects active sessions by conversation and thread and resets persisted container status at boot', () => {
  store.createAgentGroup(agent('session-agent'));
  store.createMessagingGroup(channel('session-chat'));
  for (const [id, thread] of [
    ['shared', null],
    ['threaded', 'topic-one'],
  ] as const)
    store.createSession({
      id,
      thread_id: thread,
      agent_group_id: 'session-agent',
      messaging_group_id: 'session-chat',
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now(),
    });
  expect(store.findSession('session-chat', 'topic-one')?.id).toBe('threaded');
  expect(store.getSessionsByAgentGroup('session-agent')).toHaveLength(2);
  expect(store.resetAllContainerStatus()).toBe(2);
  expect(store.getSession('shared')?.container_status).toBe('stopped');
  store.updateSession('shared', { status: 'closed' });
  expect(store.findSession('session-chat', null)).toBeUndefined();
  expect(store.getActiveSessions().map((row) => row.id)).toEqual(['threaded']);
  store.deleteSession('shared');
  expect(store.getSession('shared')).toBeUndefined();
});
it('persists question choices and safely ignores an identical retry', () => {
  store.createAgentGroup(agent('questions'));
  store.createSession({
    id: 'question-session',
    agent_group_id: 'questions',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  const question = {
    question_id: 'choice',
    session_id: 'question-session',
    message_out_id: 'question-out',
    platform_id: 'fixture-chat',
    channel_type: 'telegram',
    thread_id: null,
    title: 'Choose a fixture',
    options: [{ value: 'ada', label: 'Ada', selectedLabel: 'Ada selected' }],
    created_at: now(),
  };
  expect(store.createPendingQuestion(question)).toBe(true);
  expect(store.createPendingQuestion(question)).toBe(false);
  expect(store.getPendingQuestion('choice')?.options[0].value).toBe('ada');
  store.deletePendingQuestion('choice');
  expect(store.getPendingQuestion('choice')).toBeUndefined();
});

describe('reports', () => {
  it('records a complaint with where it came from, and lists open ones first', () => {
    const db = store.initTestDb();
    store.initializeCentralSchema(db);

    createReport({
      id: 'rep-1',
      session_id: 'sess-a',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      user_id: 'telegram:1',
      complaint: 'it filed the invoice under the wrong folder',
      context: 'user: where is the invoice\nluna: …',
    });
    createReport({
      id: 'rep-2',
      session_id: 'sess-b',
      agent_group_id: 'ag-1',
      complaint: 'no topic divider',
    });

    expect(countOpenReports()).toBe(2);

    // Resolved ones sort after open ones, whatever their age — the order somebody triaging wants.
    resolveReport('rep-1', 'routing fixed');
    const listed = listReports();
    expect(listed[0]!.status).toBe('open');
    expect(listed.map((r) => r.id)).toContain('rep-1');
    expect(countOpenReports()).toBe(1);

    const resolved = getReport('rep-1')!;
    expect(resolved.resolution).toBe('routing fixed');
    expect(resolved.resolved_at).not.toBeNull();
    // The exchange is kept, because the session it came from will be collected long before triage.
    expect(resolved.context).toContain('where is the invoice');
  });

  it('keeps a report that arrived with no description', () => {
    const db = store.initTestDb();
    store.initializeCentralSchema(db);
    const report = createReport({
      id: 'rep-3',
      session_id: 'sess-c',
      agent_group_id: 'ag-1',
      complaint: '(no description given)',
    });
    expect(report.status).toBe('open');
    expect(listReports('open').map((r) => r.id)).toEqual(['rep-3']);
  });
});
