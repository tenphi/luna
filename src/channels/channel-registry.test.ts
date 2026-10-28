import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
const routed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../router.js', () => ({ routeInbound: routed }));
vi.mock('../response-registry.js', () => ({ dispatchResponse: vi.fn().mockResolvedValue(true) }));
vi.mock('../inbound-inflight.js', () => ({ trackInboundRouting: vi.fn() }));
const setup: ChannelSetup = { onAction() {}, onMetadata() {}, onInbound() {}, onInboundEvent() {} };
function adapter(channel: string): ChannelAdapter {
  return {
    channelType: channel,
    name: `Adapter ${channel}`,
    supportsThreads: false,
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue('accepted'),
    isConnected: () => true,
  };
}
beforeEach(() => {
  vi.resetModules();
  routed.mockClear();
});
afterEach(() => vi.useRealTimers());
it('isolates absent credentials and failed factories while starting usable channels', async () => {
  const registry = await import('./channel-registry.js');
  const usable = adapter('fixture');
  registry.registerChannelAdapter('missing', { factory: () => null });
  registry.registerChannelAdapter('broken', {
    factory: () => {
      throw new Error('synthetic failure');
    },
  });
  registry.registerChannelAdapter('valid', {
    factory: async () => usable,
    containerConfig: { env: { FIXTURE: 'yes' } },
  });
  await registry.initChannelAdapters(() => setup);
  expect(registry.getActiveAdapters()).toEqual([usable]);
  expect(registry.getChannelContainerConfig('valid')?.env).toEqual({ FIXTURE: 'yes' });
  await registry.teardownChannelAdapters();
  expect(registry.getActiveAdapters()).toEqual([]);
  expect(usable.teardown).toHaveBeenCalledOnce();
});
it('retries transient network failures and preserves other channels after retry exhaustion', async () => {
  vi.useFakeTimers();
  const registry = await import('./channel-registry.js');
  const flaky = adapter('flaky');
  const failing = adapter('failing');
  const network = Object.assign(new Error('offline fixture'), { name: 'NetworkError' });
  vi.mocked(flaky.setup).mockRejectedValueOnce(network);
  vi.mocked(failing.setup).mockRejectedValue(network);
  registry.registerChannelAdapter('flaky', { factory: () => flaky });
  registry.registerChannelAdapter('failing', { factory: () => failing });
  const starting = registry.initChannelAdapters(() => setup);
  await vi.runAllTimersAsync();
  await starting;
  expect(flaky.setup).toHaveBeenCalledTimes(2);
  expect(failing.setup).toHaveBeenCalledTimes(4);
  expect(registry.getChannelAdapter('flaky')).toBe(flaky);
  expect(registry.getChannelAdapter('failing')).toBeUndefined();
});
it('uses the production delivery bridge and rejects an unavailable channel', async () => {
  const registry = await import('./channel-registry.js');
  const { createChannelDeliveryBridge } = await import('./host-events.js');
  const channel = adapter('test-channel');
  registry.registerChannelAdapter('test-channel', { factory: () => channel });
  await registry.initChannelAdapters(() => setup);
  const bridge = createChannelDeliveryBridge();
  await expect(bridge.deliver('unavailable', 'chat', null, 'chat', '{}')).rejects.toThrow('not ready');
  await bridge.deliver('test-channel', 'chat', null, 'chat', '{"text":"Synthetic reply"}', undefined, 'stable-id');
  expect(channel.deliver).toHaveBeenCalledWith('chat', null, {
    content: { text: 'Synthetic reply' },
    kind: 'chat',
    id: 'stable-id',
    files: undefined,
  });
});
it('serializes platform content while retaining adapter-confirmed group and mention signals', async () => {
  const { channelSetup } = await import('./host-events.js');
  const callbacks = channelSetup(adapter('telegram'));
  callbacks.onInbound('telegram:fixture', null, {
    id: 'fixture-input',
    kind: 'chat-sdk',
    timestamp: '2031-04-02T00:00:00Z',
    content: { text: 'Hello from Ada' },
    isGroup: true,
    isMention: true,
  });
  expect(routed).toHaveBeenCalledWith(
    expect.objectContaining({
      channelType: 'telegram',
      message: expect.objectContaining({ content: '{"text":"Hello from Ada"}', isGroup: true, isMention: true }),
    }),
  );
});
