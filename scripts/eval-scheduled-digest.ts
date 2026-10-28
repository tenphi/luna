/** Exercise Luna's scheduled digest guidance with invented mail and mocked tools. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOpenAiProviderConfig } from '../src/config/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = resolveOpenAiProviderConfig();
const agent = process.env.LUNA_EVAL_AGENT_ID;
if (!config.baseUrl || !config.model || !agent) {
  throw new Error('Scheduled digest evaluation needs a configured model and LUNA_EVAL_AGENT_ID');
}
const child = spawn('onecli', ['run', '--agent', agent, '--', 'bun', 'container/agent-runner/src/evals/scheduled-digest.ts'], {
  cwd: root,
  env: { ...process.env, OPENAI_BASE_URL: config.baseUrl, OPENAI_MODEL: config.model, OPENAI_API_KEY: 'onecli-managed',
    ...(config.extraBody && Object.keys(config.extraBody).length ? { OPENAI_EXTRA_BODY: JSON.stringify(config.extraBody) } : {}),
  },
  stdio: 'inherit',
});
child.on('error', (error) => { console.error(`Could not start evaluation: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) console.error(`Evaluation stopped by ${signal}`); process.exitCode = code ?? 1; });
