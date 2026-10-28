/** Opt-in OpenAI evaluation with synthetic tools and repository-only instructions. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../src/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runs = Number(option('--runs') ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs must be an integer from 1 to 5');
const families = [
  'source-grounding',
  'reference-capture',
  'scheduled-digest',
  'topic-boundaries',
  'public-skills',
  'adaptive-effort',
];
const family = option('--family');
if (family && !families.includes(family)) throw new Error('Unknown evaluation family');
const selected = family ? [family] : families;
const output = path.resolve(option('--out') ?? path.join(root, 'output/public-agent-eval/latest.json'));
if (!output.startsWith(path.join(root, 'output') + path.sep))
  throw new Error('--out must be under the ignored output/ directory');
const envKey = process.env.LUNA_EVAL_API_KEY ?? process.env.OPENAI_API_KEY;
const apiKey =
  envKey?.startsWith('sk-') && envKey.length > 25 ? envKey : readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
if (!apiKey) throw new Error('Set OPENAI_API_KEY or LUNA_EVAL_API_KEY to a real OpenAI API key');
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-public-eval-'));
const resultDirectory = fs.mkdtempSync(path.join(path.dirname(output), `runs-${Date.now()}-`));
const home = path.join(temp, 'home');
fs.mkdirSync(home, { mode: 0o700 });
type Scenario = {
  name: string;
  passed: boolean;
  problems: string[];
  elapsedMs: number;
  toolCalls: number;
  usage?: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number };
};
type Run = {
  family: string;
  run: number;
  exitCode: number | null;
  context?: unknown;
  results: Scenario[];
  error?: string;
};
const results: Run[] = [];
async function evaluate(family: string, run: number): Promise<Run> {
  const resultFile = path.join(resultDirectory, `${family}-${run}.json`);
  const logFile = path.join(resultDirectory, `${family}-${run}.log`);
  const log = fs.openSync(logFile, 'w', 0o600);
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('bun', [path.join(root, `container/agent-runner/src/evals/${family}.ts`)], {
      cwd: temp,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: temp,
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: 'gpt-6-luna',
        OPENAI_API: 'responses',
        LUNA_EVAL_RESULTS_PATH: resultFile,
      },
      stdio: ['ignore', log, log],
      timeout: 300_000,
      killSignal: 'SIGTERM',
    });
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  fs.closeSync(log);
  if (!fs.existsSync(resultFile))
    return { family, run, exitCode: code, results: [], error: 'Evaluation produced no result; inspect its local log' };
  const data = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as { context: unknown; results: Scenario[] };
  console.log(
    `${family}, run ${run}: ${data.results.filter((result) => result.passed).length}/${data.results.length} passed`,
  );
  return { family, run, exitCode: code, ...data };
}
try {
  // Sequential repeats; independent families can make API requests concurrently.
  for (let run = 1; run <= runs; run++) {
    results.push(...(await Promise.all(selected.map((family) => evaluate(family, run)))));
  }
  const scenarios = results.flatMap((run) => run.results);
  const passed = scenarios.filter((result) => result.passed).length;
  const failures = results.filter((run) => run.exitCode !== 0 || run.error).length;
  const report = {
    createdAt: new Date().toISOString(),
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    api: 'responses',
    reasoningEffort: 'adaptive',
    runs,
    privateStateLoaded: false,
    liveServicesCalled: false,
    tools: 'synthetic',
    passed,
    scenarios: scenarios.length,
    failedRuns: failures,
    results,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`${passed}/${scenarios.length} scenarios passed; report: ${path.relative(root, output)}`);
  if (failures || passed !== scenarios.length) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
