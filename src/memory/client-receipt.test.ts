import { afterEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => ({
  connects: 0,
  attempts: 0,
  firstFailure: 'socket closed',
}));

vi.mock('@tenphi/akno-client', () => ({
  defaultSocketPath: () => '/tmp/luna-memory-receipt-test.sock',
  connect: async () => {
    socket.connects += 1;
    return {
      hello: { version: 'test', protocol: 4, ops: [], writable: true, akno_path: '/tmp/test' },
      close: async () => {},
      call: async (_operation: string, input: { idempotency_key: string }) => {
        socket.attempts += 1;
        if (socket.attempts === 1) throw new Error(socket.firstFailure);
        return { status: 'ok', replayed: true, idempotency_key: input.idempotency_key };
      },
    };
  },
}));

import { closeMemory, withReceiptMemory } from './client.js';

afterEach(async () => {
  await closeMemory();
  socket.connects = 0;
  socket.attempts = 0;
  socket.firstFailure = 'socket closed';
  delete process.env.LUNA_ALLOW_REAL_MEMORY;
});

describe('receipt-backed memory calls', () => {
  it('reconnects after a lost reply and obtains the stored receipt with the same key', async () => {
    process.env.LUNA_ALLOW_REAL_MEMORY = '1'; // The client is mocked; no live service is reachable.
    const input = { idempotency_key: 'test:invented-write', slug: 'fictional/page', content: 'Invented fact.' };
    const result = await withReceiptMemory(input.idempotency_key, (client) => client.call('write', input));
    expect(result).toMatchObject({ status: 'ok', replayed: true, idempotency_key: input.idempotency_key });
    expect(socket.connects).toBe(2);
    expect(socket.attempts).toBe(2);
  });

  it('does not replay backend failures', async () => {
    process.env.LUNA_ALLOW_REAL_MEMORY = '1';
    socket.firstFailure = 'validation failed';
    await expect(
      withReceiptMemory('test:failed', (client) =>
        client.call('write', { idempotency_key: 'test:failed', slug: 'fictional/page' }),
      ),
    ).rejects.toThrow('validation failed');
    expect(socket.attempts).toBe(1);
  });
});
