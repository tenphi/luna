import { getTheAgent } from '../../bootstrap.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { readStoredContainerConfig, writeStoredContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { parseBoolFlag } from '../parse-bool-flag.js';
import { register } from '../registry.js';

register({
  name: 'restart',
  description: 'Restart the agent container. Use --rebuild for package changes; --message for on-wake instruction.',
  access: 'approval',
  parseArgs: (raw) => ({
    rebuild: parseBoolFlag(raw.rebuild),
    message: raw.message as string | undefined,
  }),
  handler: async (args, ctx) => {
    const id = ctx.caller === 'agent' ? ctx.agentGroupId : getTheAgent().id;
    const ag = getAgentGroup(id);
    if (!ag) throw new Error('Agent group not found.');
    let rebuilt = false;
    let clearedImageTag = false;

    if (args.rebuild) {
      const stored = readStoredContainerConfig(ag);
      const aptPackages = stored.packages.apt;
      const npmPackages = stored.packages.npm;
      if (aptPackages.length === 0 && npmPackages.length === 0) {
        if (stored.imageTag) {
          const { imageTag: _removed, ...rest } = stored;
          writeStoredContainerConfig(rest);
          clearedImageTag = true;
        }
      } else {
        await buildAgentGroupImage(id);
        rebuilt = true;
      }
    }

    const message = args.message;

    if (ctx.caller === 'agent') {
      if (message) {
        writeSessionMessage(id, ctx.sessionId, {
          id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: id,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
          onWake: 1,
        });
      }
      killContainer(
        ctx.sessionId,
        'restarted via luna',
        message
          ? () => {
              const s = getSession(ctx.sessionId);
              if (s) wakeContainer(s);
            }
          : undefined,
      );
      return { restarted: 1, rebuilt, cleared_image_tag: clearedImageTag || undefined };
    }

    const count = restartAgentGroupContainers(id, 'restarted via luna', message);
    return { restarted: count, rebuilt, cleared_image_tag: clearedImageTag || undefined };
  },
});
