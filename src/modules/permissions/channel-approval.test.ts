import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LunaConfigDoc } from '../../config/schema.js';
const fixture = vi.hoisted(() => ({
  root: '/tmp/luna-channel-approval-contracts',
  config: {} as LunaConfigDoc,
  deliver: vi.fn().mockResolvedValue('synthetic-card'),
  wake: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../config/loader.js', async (original) => ({
  ...(await original<typeof import('../../config/loader.js')>()),
  loadLunaConfig: () => fixture.config,
}));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: fixture.root,
}));
vi.mock('../../install-paths.js', () => ({
  getAgentDir: () => `${fixture.root}/agent`,
  getMountAllowlistPath: () => `${fixture.root}/mounts.json`,
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: fixture.wake,
  isContainerRunning: () => false,
  killContainer: vi.fn(),
}));
vi.mock('../../delivery.js', async (original) => ({
  ...(await original<typeof import('../../delivery.js')>()),
  getDeliveryAdapter: () => ({ deliver: fixture.deliver }),
}));
vi.mock('./user-dm.js', () => ({
  ensureUserDm: async (id: string) => {
    const { getMessagingGroup } = await import('../../db/messaging-groups.js');
    return id === 'telegram:1000000001' ? (getMessagingGroup('owner-conversation') ?? null) : null;
  },
}));
import { closeDb, initTestDb, initializeCentralSchema } from '../../db/index.js';
import { createAgentGroup, deleteAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
} from '../../db/messaging-groups.js';
import { createUser } from './db/users.js';
import { resolveUserKey } from '../../users/binding.js';
import { getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { routeInbound } from '../../router.js';
import { dispatchResponse } from '../../response-registry.js';
import type { InboundEvent } from '../../channels/adapter.js';
const at = '2031-04-02T00:00:00Z';
beforeEach(async () => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.mkdirSync(fixture.root, { recursive: true });
  fixture.config = {
    owner: 'ada',
    users: {
      ada: { name: 'Ada Marlow', telegramHandle: 'ada_marlow' },
      bo: { name: 'Bo Winters', telegramHandle: 'bo_winters' },
    },
  };
  initializeCentralSchema(initTestDb());
  await import('../index.js');
  createAgentGroup({ id: 'fixture-agent', name: 'Luna', agent_provider: null, created_at: at });
  createMessagingGroup({
    id: 'owner-conversation',
    channel_type: 'telegram',
    platform_id: 'telegram:1000000001',
    name: 'Owner fixture DM',
    is_group: 0,
    created_at: at,
  });
  createUser({
    id: 'telegram:1000000001',
    kind: 'telegram',
    platform_username: 'ada_marlow',
    display_name: 'Ada Marlow',
    created_at: at,
  });
  resolveUserKey('telegram:1000000001');
  fixture.deliver.mockClear();
  fixture.wake.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
function event(grouped = true): InboundEvent {
  return {
    channelType: 'telegram',
    platformId: grouped ? 'telegram:-1000000010' : 'telegram:1000000099',
    threadId: null,
    message: {
      id: `fixture-${grouped}`,
      kind: 'chat-sdk',
      timestamp: at,
      isMention: true,
      isGroup: grouped,
      content: JSON.stringify({
        text: 'A synthetic mention',
        author: { userId: '1000000002', userName: 'bo_winters', fullName: 'Bo Winters' },
      }),
    },
  };
}
async function offered(input = event()) {
  await routeInbound(input);
  await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalled());
  return JSON.parse(fixture.deliver.mock.calls[0][4]) as { questionId: string; options: { value: string }[] };
}
async function choose(id: string, value: string, userId = 'telegram:1000000001') {
  return dispatchResponse({ questionId: id, value, userId, channelType: 'telegram', platformId: '', threadId: null });
}
it.each([true, false])('persists an actionable channel question for group=%s', async (grouped) => {
  const question = await offered(event(grouped));
  expect(question.options.map((option) => option.value)).toEqual(['connect:fixture-agent', 'reject']);
  expect(getPendingChannelApproval(question.questionId)?.agent_group_id).toBe('fixture-agent');
});
it('offers one card while repeated mentions await a decision', async () => {
  await Promise.all([
    routeInbound(event()),
    routeInbound({ ...event(), message: { ...event().message, id: 'second-mention' } }),
  ]);
  await vi.waitFor(() => expect(fixture.deliver).toHaveBeenCalledOnce());
});
it.each([true, false])(
  'connects an approved conversation with correct group=%s behavior and replays the roster user',
  async (grouped) => {
    const question = await offered(event(grouped));
    await choose(question.questionId, 'connect:fixture-agent');
    const wiring = getMessagingGroupAgents(question.questionId);
    expect(wiring).toHaveLength(1);
    expect(wiring[0]).toMatchObject({
      engage_mode: grouped ? 'mention-sticky' : 'pattern',
      engage_pattern: grouped ? null : '.',
      ignored_message_policy: 'accumulate',
    });
    expect(getPendingChannelApproval(question.questionId)).toBeUndefined();
    expect(fixture.wake).toHaveBeenCalledOnce();
  },
);
it('keeps rejected groups quiet and refuses an unauthorized or forged connection choice', async () => {
  const question = await offered();
  await choose(question.questionId, 'connect:fixture-agent', 'telegram:1000000002');
  await choose(question.questionId, 'connect:another-agent');
  expect(getMessagingGroupAgents(question.questionId)).toEqual([]);
  await choose(question.questionId, 'reject');
  fixture.deliver.mockClear();
  await routeInbound(event());
  expect(getMessagingGroupByPlatform('telegram', event().platformId)?.denied_at).toBeTruthy();
  expect(fixture.deliver).not.toHaveBeenCalled();
});
it('does not queue a card when no configured owner has a reachable delivery address', async () => {
  fixture.config = {};
  await routeInbound(event());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fixture.deliver).not.toHaveBeenCalled();
  const group = getMessagingGroupByPlatform('telegram', event().platformId)!;
  expect(getPendingChannelApproval(group.id)).toBeUndefined();
});
it('can prepare the install agent before offering a first channel', async () => {
  deleteAgentGroup('fixture-agent');
  const question = await offered();
  const agent = getAllAgentGroups()[0];
  expect(agent.name).toBe('Luna');
  expect(question.options[0].value).toBe(`connect:${agent.id}`);
});
