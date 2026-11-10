import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as prompts from '@clack/prompts';
import kleur from 'kleur';
import * as setupLog from '../logs.js';
import { fitToWidth, fmtDuration } from './theme.js';

export type Fields = Record<string, string>;
export type Block = { type: string; fields: Fields };
export type StepResult = { ok: boolean; exitCode: number; transcript: string; blocks: Block[]; terminal: Block | null };
export type QuietChildResult = StepResult;
export type SpinnerLabels = { running: string; done: string; skipped?: string; failed?: string };

export class StatusStream {
  readonly blocks: Block[] = [];
  transcript = '';
  private pending = '';
  private block?: Block;
  constructor(private readonly accept: (block: Block) => void) {}
  write(text: string): void {
    this.transcript += text;
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop()!;
    lines.forEach((line) => this.line(line.replace(/\r$/, '')));
  }
  finish(): void {
    if (this.pending) this.line(this.pending.replace(/\r$/, ''));
    this.pending = '';
  }
  private line(text: string): void {
    const heading = /^=== LUNA SETUP: (\S+) ===/.exec(text);
    if (heading) {
      this.block = { type: heading[1], fields: {} };
      return;
    }
    if (text.startsWith('=== END ===')) {
      const complete = this.block;
      this.block = undefined;
      if (complete) {
        this.blocks.push(complete);
        this.accept(complete);
      }
      return;
    }
    const field = /^\s*([^:]+):\s*(.*)$/.exec(text);
    if (this.block && field) this.block.fields[field[1].trim()] = field[2].trim();
  }
}

function redacted(args: string[]): string[] {
  let hideNext = false;
  return args.map((argument) => {
    if (hideNext) {
      hideNext = false;
      return '[redacted]';
    }
    const flag = argument.split('=')[0];
    const secret = ['--value', '--token', '--api-key', '--api-token', '--app-password'].includes(flag);
    hideNext = secret && !argument.includes('=');
    return secret && argument.includes('=') ? `${flag}=[redacted]` : argument;
  });
}

function capture(
  command: string,
  args: string[],
  file: string,
  options?: {
    block?: (block: Block) => void;
    line?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
    requireStatus?: boolean;
  },
): Promise<StepResult> {
  return new Promise((resolve) => {
    const raw = fs.createWriteStream(file, { mode: 0o600 });
    raw.once('open', () => fs.chmodSync(file, 0o600));
    raw.write(`# ${command} ${redacted(args).join(' ')}\n`);
    const status = new StatusStream(options?.block ?? (() => {}));
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...options?.env } });
    let transcript = '';
    let completed = false;
    const finish = (code: number, error?: Error): void => {
      if (completed) return;
      completed = true;
      if (error) {
        transcript += `${error.message}\n`;
        raw.write(`${error.message}\n`);
      }
      status.finish();
      const terminal = status.blocks.filter((block) => Boolean(block.fields.STATUS)).slice(-1)[0] ?? null;
      const accepted = ['success', 'skipped'].includes(terminal?.fields.STATUS ?? '');
      raw.end(() =>
        resolve({
          exitCode: code,
          ok: code === 0 && (!options?.requireStatus || accepted),
          transcript,
          terminal,
          blocks: status.blocks,
        }),
      );
    };
    raw.once('error', (error) => {
      completed = true;
      child.kill();
      resolve({
        ok: false,
        exitCode: 1,
        transcript: `${transcript}\nCould not save the setup log: ${error.message}`,
        blocks: status.blocks,
        terminal: null,
      });
    });
    for (const [output, isStdout] of [
      [child.stdout, true],
      [child.stderr, false],
    ] as const) {
      output.setEncoding('utf8');
      let pending = '';
      output.on('data', (text: string) => {
        transcript += text;
        raw.write(text);
        if (isStdout) status.write(text);
        if (!options?.line) return;
        const lines = (pending + text).split('\n');
        pending = lines.pop()!;
        for (const line of lines) if (line.trim() && !line.startsWith('=== ')) options.line(line.replace(/\r/g, ''));
      });
      output.once('end', () => {
        if (pending.trim() && !pending.startsWith('=== ')) options?.line?.(pending);
      });
    }
    child.once('error', (error) => finish(1, error));
    child.once('close', (code) => finish(code ?? 1));
  });
}
export function spawnStep(
  name: string,
  extra: string[],
  onBlock: (block: Block) => void,
  rawLogPath: string,
  onLine?: (line: string) => void,
): Promise<StepResult> {
  return capture(
    'pnpm',
    ['exec', 'tsx', 'setup/index.ts', '--step', name, ...(extra.length ? ['--', ...extra] : [])],
    rawLogPath,
    { block: onBlock, line: onLine, requireStatus: true },
  );
}
export function spawnQuiet(
  command: string,
  args: string[],
  rawLogPath: string,
  env?: NodeJS.ProcessEnv,
): Promise<QuietChildResult> {
  return capture(command, args, rawLogPath, { env });
}

export function summariseTerminalFields(block: Block | null): Fields {
  return Object.fromEntries(
    Object.entries(block?.fields ?? {}).filter(
      ([key, value]) => key !== 'STATUS' && key !== 'LOG' && value.length <= 120,
    ),
  );
}
function outcome(result: StepResult): 'success' | 'failed' | 'skipped' {
  if (!result.ok) return 'failed';
  return result.terminal?.fields.STATUS === 'skipped' ? 'skipped' : 'success';
}
export function writeStepEntry(name: string, result: StepResult, durationMs: number, rawLog: string): void {
  setupLog.step(name, outcome(result), durationMs, summariseTerminalFields(result.terminal), rawLog);
}
async function spinning(labels: SpinnerLabels, work: () => Promise<StepResult>): Promise<StepResult> {
  const spinner = prompts.spinner();
  const started = Date.now();
  const timed = (text: string): string => {
    const time = ` (${fmtDuration(Date.now() - started)})`;
    return fitToWidth(text, time) + kleur.dim(time);
  };
  spinner.start(timed(labels.running));
  const interval = setInterval(() => spinner.message(timed(labels.running)), 1000);
  try {
    const result = await work();
    const label = !result.ok
      ? (labels.failed ?? 'Step failed')
      : outcome(result) === 'skipped'
        ? (labels.skipped ?? labels.done)
        : labels.done;
    spinner.stop(timed(kleur.bold(label)));
    if (!result.ok) dumpTranscriptOnFailure(result.transcript);
    return result;
  } catch (error) {
    spinner.stop(timed(labels.failed ?? 'Step failed'));
    throw error;
  } finally {
    clearInterval(interval);
  }
}
export async function runQuietStep(name: string, labels: SpinnerLabels, extra: string[] = []) {
  const rawLog = setupLog.stepRawLog(name);
  const started = Date.now();
  const result = await spinning(labels, () => spawnStep(name, extra, () => {}, rawLog));
  const durationMs = Date.now() - started;
  writeStepEntry(name, result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}
export async function runQuietChild(
  name: string,
  command: string,
  args: string[],
  labels: SpinnerLabels,
  options?: { extraFields?: Record<string, string | number | boolean>; env?: NodeJS.ProcessEnv },
) {
  const rawLog = setupLog.stepRawLog(name);
  const started = Date.now();
  const result = await spinning(labels, () => spawnQuiet(command, args, rawLog, options?.env));
  const durationMs = Date.now() - started;
  setupLog.step(
    name,
    outcome(result),
    durationMs,
    { ...summariseTerminalFields(result.terminal), ...options?.extraFields },
    rawLog,
  );
  return { ...result, rawLog, durationMs };
}
export function dumpTranscriptOnFailure(transcript: string): void {
  const visible = transcript
    .split('\n')
    .filter((line) => !line.startsWith('=== '))
    .slice(-40)
    .join('\n')
    .trim();
  if (visible) console.log(`\n${kleur.dim(visible)}\n`);
}
export async function fail(stepName: string, message: string, hint?: string, _rawLogPath?: string): Promise<never> {
  setupLog.abort(stepName, message);
  prompts.log.error(message);
  if (hint) prompts.log.message(kleur.dim(hint));
  prompts.log.message(kleur.dim('Details: logs/setup.log and logs/setup-steps/'));
  prompts.cancel('Setup aborted.');
  process.exit(1);
}
export function ensureAnswer<T>(value: T | symbol): Exclude<T, symbol> {
  if (prompts.isCancel(value)) {
    prompts.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}
