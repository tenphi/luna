import { getChannelAdapter, getRegisteredChannelNames } from '../../channels/channel-registry.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'channels-list',
  description: 'List channel adapters registered in this install',
  access: 'hidden',
  parseArgs: () => ({}),
  handler: async (_args, _ctx: CallerContext) => {
    return {
      channels: getRegisteredChannelNames().map((channel_type) => ({
        channel_type,
        adapter: getChannelAdapter(channel_type)?.constructor.name ?? 'unknown',
      })),
    };
  },
});
