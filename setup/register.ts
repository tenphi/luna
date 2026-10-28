import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { initializeCentralSchema } from '../src/db/initialize.js';
import { getTheAgent } from '../src/bootstrap.js';
import { updateAgentGroup } from '../src/db/agent-groups.js';
import { initAgentFilesystem } from '../src/agent-init.js';
import { connectChannel } from '../src/channel-wiring.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';
import type { MessagingGroupAgent } from '../src/types.js';
import { optionValue, requireOption } from './lib/arguments.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const address = requireOption(args, '--platform-id');
  const name = requireOption(args, '--name');
  const channel = (optionValue(args, '--channel') || 'telegram').toLowerCase();
  const assistant = optionValue(args, '--assistant-name') || 'Luna';
  const mode = optionValue(args, '--session-mode') || 'shared';
  if (!['shared', 'per-thread', 'agent-shared'].includes(mode)) throw new Error('Invalid session mode');
  const pattern = optionValue(args, '--trigger');
  if (pattern) new RegExp(pattern);
  initializeCentralSchema(initDb(path.join(DATA_DIR, 'luna.db')));
  try {
    const agent = getTheAgent({ agentName: assistant });
    updateAgentGroup(agent.id, { name: assistant });
    initAgentFilesystem(agent);
    const { group, newlyWired } = connectChannel({
      agentId: agent.id,
      channel,
      address,
      name,
      isGroup: true,
      pattern,
      sessionMode: mode as MessagingGroupAgent['session_mode'],
    });
    if (newlyWired) {
      const { session } = resolveSession(agent.id, group.id, null, mode as MessagingGroupAgent['session_mode']);
      writeSessionMessage(agent.id, session.id, {
        id: `onboard-${randomUUID()}`,
        kind: 'task',
        timestamp: new Date().toISOString(),
        channelType: channel,
        platformId: group.platform_id,
        content: JSON.stringify({
          prompt: 'Introduce yourself with the welcome skill for this newly connected channel.',
        }),
      });
    }
    emitStatus('REGISTER_CHANNEL', {
      PLATFORM_ID: group.platform_id,
      NAME: name,
      CHANNEL: channel,
      ASSISTANT_NAME: assistant,
      SESSION_MODE: mode,
      TRIGGER: pattern ?? '',
      STATUS: 'success',
    });
  } finally {
    closeDb();
  }
}
