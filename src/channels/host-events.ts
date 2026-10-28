import type { ChannelAdapter, ChannelSetup, InboundEvent } from './adapter.js';
import { getChannelAdapter } from './channel-registry.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { trackInboundRouting } from '../inbound-inflight.js';
import { routeInbound } from '../router.js';
import { dispatchResponse } from '../response-registry.js';
import { log } from '../log.js';

export function createChannelDeliveryBridge(): ChannelDeliveryAdapter {
  return {
    deliver: async (channel, platform, thread, kind, content, files, id) => {
      const adapter = getChannelAdapter(channel);
      if (!adapter) throw new Error(`Channel ${channel} is not ready for delivery`);
      return adapter.deliver(platform, thread, { content: JSON.parse(content), kind, files, id });
    },
    setTyping: async (channel, platform, thread) => {
      await getChannelAdapter(channel)?.setTyping?.(platform, thread);
    },
  };
}
export function channelSetup(adapter: ChannelAdapter): ChannelSetup {
  const forward = (event: InboundEvent): void => {
    trackInboundRouting(
      routeInbound(event).catch((error) =>
        log.error('Inbound routing failed', { channel: adapter.channelType, error }),
      ),
    );
  };
  return {
    onInboundEvent: forward,
    onInbound: (platformId, threadId, message) =>
      forward({
        channelType: adapter.channelType,
        platformId,
        threadId,
        message: { ...message, content: JSON.stringify(message.content) },
      }),
    onMetadata: (platformId, _name, isGroup) =>
      log.debug('Conversation discovered', {
        channel: adapter.channelType,
        platformId,
        isGroup,
      }),
    onAction: (questionId, value, userId) => {
      void dispatchResponse({
        channelType: adapter.channelType,
        questionId,
        value,
        userId,
        platformId: '',
        threadId: null,
      }).catch((error) => log.error('Question response failed', { questionId, error }));
    },
  };
}
