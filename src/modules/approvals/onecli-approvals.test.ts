import type { ApprovalRequest } from '@onecli-sh/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, initTestDb } from '../../db/connection.js';
import { initializeCentralSchema } from '../../db/initialize.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import {
  ONECLI_ACTION,
  resolveOneCLIApproval,
  startOneCLIApprovalHandler,
  stopOneCLIApprovalHandler,
} from './onecli-approvals.js';
const sdk = vi.hoisted(() => ({
  request: undefined as undefined | ((request: ApprovalRequest) => Promise<'approve' | 'deny'>),
}));
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval(callback: typeof sdk.request) {
      sdk.request = callback;
      return { stop() {} };
    }
  },
}));
vi.mock('../../config.js', () => ({ ONECLI_URL: 'http://onecli.invalid', ONECLI_API_KEY: 'synthetic' }));
const deliveryChoice = vi.hoisted(() => vi.fn());
vi.mock('./primitive.js', () => ({
  pickApprover: () => ['telegram:ada'],
  pickApprovalDelivery: deliveryChoice,
}));
let deliver: ReturnType<typeof vi.fn>;
const request = (): ApprovalRequest =>
  ({
    id: 'fixture-request',
    method: 'GET',
    host: 'example.test',
    path: '/fixture',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    agent: { name: 'Synthetic agent' },
  }) as ApprovalRequest;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
  initializeCentralSchema(initTestDb());
  deliver = vi.fn().mockResolvedValue('fixture-message');
  deliveryChoice.mockResolvedValue({
    userId: 'telegram:ada',
    messagingGroup: { channel_type: 'telegram', platform_id: 'synthetic-chat' },
  });
  startOneCLIApprovalHandler({ deliver } as unknown as ChannelDeliveryAdapter);
});
afterEach(() => {
  stopOneCLIApprovalHandler();
  closeDb();
  vi.useRealTimers();
});
async function sent(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
it('registers the pending request before delivery so a fast approval is not lost', async () => {
  deliver.mockImplementation(async (_channel, _platform, _thread, _kind, json) => {
    const card = JSON.parse(json);
    expect(card.questionId.length).toBeLessThan(16);
    expect(resolveOneCLIApproval(card.questionId, 'approve')).toBe(true);
    return 'fixture-message';
  });
  expect(await sdk.request!(request())).toBe('approve');
  expect(getPendingApprovalsByAction(ONECLI_ACTION)).toEqual([]);
});
it('denies outstanding requests when the host stops', async () => {
  const decision = sdk.request!(request());
  await sent();
  stopOneCLIApprovalHandler();
  expect(await decision).toBe('deny');
  expect(getPendingApprovalsByAction(ONECLI_ACTION)).toEqual([]);
});
it('denies and expires a request that receives no answer', async () => {
  const decision = sdk.request!(request());
  await sent();
  await vi.advanceTimersByTimeAsync(59000);
  expect(await decision).toBe('deny');
  expect(getPendingApprovalsByAction(ONECLI_ACTION)).toEqual([]);
  expect(deliver).toHaveBeenCalledTimes(2);
});

it('denies a request whose delivery lookup finishes after shutdown', async () => {
  let complete!: (target: unknown) => void;
  deliveryChoice.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const answer = sdk.request!(request());
  await sent();
  stopOneCLIApprovalHandler();
  complete({ userId: 'telegram:ada', messagingGroup: { channel_type: 'telegram', platform_id: 'synthetic-chat' } });
  expect(await answer).toBe('deny');
  expect(deliver).not.toHaveBeenCalled();
  expect(getPendingApprovalsByAction(ONECLI_ACTION)).toEqual([]);
});
