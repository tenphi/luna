import { getTheAgent } from '../../bootstrap.js';
import { createMessagingGroupAgent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

register({
  name: 'wire',
  description: 'Wire a messaging group to the install agent (escape hatch)',
  access: 'hidden',
  parseArgs: (raw) => {
    const channel = String(raw.channel ?? raw.channel_type ?? '');
    let platformId = String(raw['platform-id'] ?? raw.platform_id ?? '');
    if (!channel) throw new Error('--channel is required');
    if (channel === 'cli' && !platformId) platformId = 'local';
    if (!platformId) throw new Error('--platform-id is required');
    return { channel, platformId, sessionMode: String(raw['session-mode'] ?? 'shared') };
  },
  handler: async (args, _ctx: CallerContext) => {
    const ag = getTheAgent();
    const mg = getMessagingGroupByPlatform(args.channel, args.platformId);
    if (!mg) throw new Error(`messaging group not found: ${args.channel}/${args.platformId}`);
    const id = `mga-${Date.now()}`;
    createMessagingGroupAgent({
      id,
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      ignored_message_policy: 'drop',
      session_mode: args.sessionMode as 'shared' | 'per-thread' | 'agent-shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
    return { wired: id, messaging_group_id: mg.id, agent_group_id: ag.id };
  },
});
