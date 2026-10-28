import path from 'node:path';
import { bootstrapCliAgent } from '../src/bootstrap.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { initializeCentralSchema } from '../src/db/initialize.js';
import { DATA_DIR } from '../src/config.js';
import { optionValue, requireOption } from './lib/arguments.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const displayName = requireOption(args, '--display-name');
  const agentName = optionValue(args, '--agent-name');
  try {
    initializeCentralSchema(initDb(path.join(DATA_DIR, 'luna.db')));
    const identity = bootstrapCliAgent({ displayName, agentName });
    emitStatus('CLI_AGENT', {
      STATUS: 'success', AGENT_ID: identity.id, AGENT_NAME: identity.name,
      DISPLAY_NAME: displayName, CHANNEL: 'cli/local', LOG: 'logs/setup.log',
    });
  } finally { closeDb(); }
}
