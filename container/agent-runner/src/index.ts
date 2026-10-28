import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeMcpServers } from './mcp-tools/build-mcp-servers.js';
import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
import './providers/index.js';
import { createProvider } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

async function start(): Promise<void> {
  const configuration = loadConfig();
  const name = configuration.provider.toLowerCase();
  const directories: string[] = [];
  const extra = '/workspace/extra';
  if (fs.existsSync(extra)) {
    for (const item of fs.readdirSync(extra)) {
      const directory = path.join(extra, item);
      if (fs.statSync(directory).isDirectory()) directories.push(directory);
    }
  }
  const instructions = await buildSystemPromptAddendum(configuration.assistantName || undefined);
  const provider = createProvider(name, {
    assistantName: configuration.assistantName || undefined,
    mcpServers: buildRuntimeMcpServers(configuration.mcpServers, {
      command: 'bun', args: ['run', fileURLToPath(new URL('./mcp-tools/index.ts', import.meta.url))], env: {},
    }),
    env: { ...process.env }, additionalDirectories: directories.length ? directories : undefined,
    model: configuration.model, effort: configuration.effort, context: configuration.context,
    apple: configuration.apple, memory: configuration.memory,
  });
  console.error(`[agent-runner] Starting ${name}`);
  await runPollLoop({ provider, providerName: name, cwd: '/workspace/agent', systemContext: { instructions } });
}
void start().catch((error) => {
  console.error('[agent-runner] Startup failed', error);
  process.exit(1);
});
