/** Run the synthetic source-grounding evaluation with Luna's installed model and OneCLI agent. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOpenAiProviderConfig } from '../src/config/loader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = resolveOpenAiProviderConfig();
const agent = process.env.LUNA_EVAL_AGENT_ID;

if (!config.baseUrl || !config.model) {
  throw new Error('Source-grounding evaluation needs the configured OpenAI endpoint and model');
}
if (!agent) {
  throw new Error('Set LUNA_EVAL_AGENT_ID to a configured Luna agent-group identifier');
}

// Luna's containers reach the model through OneCLI. A host-side direct call
// would send the install's placeholder key to the API and fail authentication.
const child = spawn(
  'onecli',
  [
    'run',
    '--agent',
    agent,
    '--',
    'bun',
    'container/agent-runner/src/evals/source-grounding.ts',
    ...process.argv.slice(2),
  ],
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
