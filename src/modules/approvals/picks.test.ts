import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LunaConfigDoc } from '../../config/schema.js';
const fixture = vi.hoisted(() => ({ config: {} as LunaConfigDoc, dm: vi.fn() }));
vi.mock('../../config/loader.js', async (original) => ({
  ...(await original<typeof import('../../config/loader.js')>()),
  loadLunaConfig: () => fixture.config,
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: fixture.dm }));
import { closeDb, initTestDb, initializeCentralSchema } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import { resolveUserKey } from '../../users/binding.js';
import { pickApprover, pickApprovalDelivery } from './primitive.js';
beforeEach(() => {
  fixture.config = {
    owner: 'ada',
    users: { ada: { telegramHandle: 'ada_marlow' }, bo: { telegramHandle: 'bo_winters' } },
  };
  fixture.dm.mockReset();
  initializeCentralSchema(initTestDb());
});
afterEach(closeDb);
it('keeps terminal approval available before an owner has a bound messaging identity', () => {
  expect(pickApprover()).toEqual(['cli:local']);
});
it('offers the bound owner and terminal without promoting another roster member', () => {
  for (const [id, handle] of [
    ['telegram:1000000001', 'ada_marlow'],
    ['telegram:1000000002', 'bo_winters'],
  ]) {
    createUser({
      id,
      kind: 'telegram',
      platform_username: handle,
      display_name: null,
      created_at: '2031-04-02T00:00:00Z',
    });
    resolveUserKey(id);
  }
  expect(pickApprover()).toEqual(['telegram:1000000001', 'cli:local']);
});
it.each([
  ['email', ['telegram:ada', 'email:ada@example.test'], 'email:ada@example.test'],
  ['unavailable', ['telegram:ada', 'email:ada@example.test'], 'telegram:ada'],
] as const)('selects a reachable approver for %s', async (origin, identities, expected) => {
  fixture.dm.mockImplementation(async (user: string) => ({ id: `fixture-${user}`, platform_id: user }));
  expect((await pickApprovalDelivery([...identities], origin))?.userId).toBe(expected);
});
it('tries fallback identities once and reports when no delivery address is reachable', async () => {
  fixture.dm.mockResolvedValue(null);
  expect(await pickApprovalDelivery(['telegram:ada', 'telegram:ada', 'cli:local'], 'telegram')).toBeNull();
  expect(fixture.dm.mock.calls.map((call) => call[0])).toEqual(['telegram:ada', 'cli:local']);
});
