import { describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
vi.mock('../../db/sessions.js', () => ({ getSession }));
vi.mock('../../session-manager.js', () => ({ sessionDbPath: () => '/missing/session.db' }));

import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';
import './deliveries.js';

const AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 'session',
  agentGroupId: 'group',
  messagingGroupId: 'chat',
};

describe('delivery recovery commands', () => {
  it('requires exact session, message and reason for dismissal', () => {
    const command = lookup('deliveries-dismiss')!;
    for (const raw of [{}, { session: 's' }, { session: 's', id: 'm' }, { session: 's', id: 'm', reason: true }]) {
      expect(() => command.parseArgs(raw)).toThrow(/Pass --/);
    }
  });

  it('rejects agent callers before looking up or opening any session', async () => {
    for (const name of ['deliveries-list', 'deliveries-dismiss']) {
      const command = lookup(name)!;
      await expect(
        command.handler(command.parseArgs({ session: 's', id: 'm', reason: 'Reviewed' }), AGENT),
      ).rejects.toThrow('only on the host');
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it('refuses unknown sessions rather than creating a new database', async () => {
    getSession.mockReturnValue(undefined);
    const command = lookup('deliveries-dismiss')!;
    await expect(
      command.handler(command.parseArgs({ session: 'missing', id: 'm', reason: 'Reviewed' }), { caller: 'host' }),
    ).rejects.toThrow('Session not found');
  });
});
