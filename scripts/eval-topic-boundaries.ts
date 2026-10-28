/** Run invented topic-boundary cases through Luna's configured OneCLI model. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOpenAiProviderConfig } from '../src/config/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = resolveOpenAiProviderConfig();
const agent = process.env.LUNA_EVAL_AGENT_ID;

if (!config.baseUrl || !config.model) throw new Error('Topic-boundary evaluation needs the configured model');
if (!agent) throw new Error('Set LUNA_EVAL_AGENT_ID to a configured Luna agent-group identifier');

const child = spawn(
  'onecli',
  ['run', '--agent', agent, '--', 'bun', 'container/agent-runner/src/evals/topic-boundaries.ts'],
  {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_BASE_URL: config.baseUrl,
      OPENAI_MODEL: config.model,
      OPENAI_API_KEY: 'onecli-managed',
      ...(config.extraBody && Object.keys(config.extraBody).length > 0
        ? { OPENAI_EXTRA_BODY: JSON.stringify(config.extraBody) }
        : {}),
    },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error(`Could not start the evaluation: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`Evaluation stopped by ${signal}`);
  process.exitCode = code ?? 1;
});
