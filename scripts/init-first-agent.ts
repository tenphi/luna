import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { buildDefaultLocalInstructions, getTheAgent } from '../src/bootstrap.js';
import { loadLunaConfig } from '../src/config/loader.js';
import { resolveAssistantName } from '../src/config/unified-agent.js';
import { updateAgentGroup } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { initializeCentralSchema } from '../src/db/initialize.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { updateStoredContainerConfig } from '../src/container-config.js';
import { initAgentFilesystem } from '../src/agent-init.js';
import { connectChannel } from '../src/channel-wiring.js';
import { optionValue, requireOption } from '../setup/lib/arguments.js';

async function initialize(): Promise<void> {
  const args = process.argv.slice(2);
  const channel = requireOption(args, '--channel').toLowerCase();
  const rawUser = requireOption(args, '--user-id');
  const address = requireOption(args, '--platform-id');
  const name = requireOption(args, '--display-name');
  const assistant = optionValue(args, '--agent-name')?.trim() || resolveAssistantName(loadLunaConfig()) || 'Luna';
  const senderId = rawUser.includes(':') ? rawUser : `${channel}:${rawUser}`;
  initializeCentralSchema(initDb(path.join(DATA_DIR, 'luna.db')));
  let target;
  try {
    upsertUser({ id: senderId, kind: channel, display_name: name, created_at: new Date().toISOString() });
    const instructions = buildDefaultLocalInstructions(name);
    const agent = getTheAgent({ agentName: assistant, displayName: name, instructions });
    updateAgentGroup(agent.id, { name: assistant });
    initAgentFilesystem(agent, { instructions });
    updateStoredContainerConfig(agent.id, { cliScope: 'global' });
    target = connectChannel({ agentId: agent.id, channel, address, name, isGroup: false }).group;
  } finally {
    closeDb();
  }
  const text =
    optionValue(args, '--welcome')?.trim() ||
    'Introduce yourself using the welcome skill and explain what is available on this install.';
  // The protected host socket supplies transport; the paired identity still passes the roster gate.
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(path.join(DATA_DIR, 'cli.sock'));
    const timeout = setTimeout(
      () => socket.destroy(new Error('The Luna service did not accept the welcome within 10 seconds')),
      10_000,
    );
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timeout));
    socket.once('connect', () =>
      socket.end(
        JSON.stringify({
          text,
          senderId,
          sender: name,
          to: { channelType: target.channel_type, platformId: target.platform_id, threadId: null },
        }) + '\n',
      ),
    );
    socket.once('finish', resolve);
  });
  console.log('Channel connected. The welcome has been handed to the Luna service.');
}
initialize().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
