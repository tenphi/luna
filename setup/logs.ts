import fs from 'node:fs';
import path from 'node:path';
import { fmtDuration } from './lib/theme.js';

export const progressLogPath = path.join('logs', 'setup.log');
export const stepsDir = path.join('logs', 'setup-steps');
const finished = new Set<string>();
const timestamp = (): string => new Date().toISOString();
const secret = (key: string, value: unknown): string => /token|secret|password|api.?key|credential/i.test(key) ? '[redacted]' : String(value);
function append(text: string): void {
  fs.mkdirSync(path.dirname(progressLogPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(progressLogPath, `${text}\n`, { mode: 0o600 });
}
export const completedStepNames = (): string[] => Array.from(finished);
export function header(metadata: Record<string, string>): void {
  append([`## ${timestamp()} · setup:auto started`, ...Object.entries(metadata).map(([key, value]) => `  ${key}: ${secret(key, value)}`), ''].join('\n'));
}
export function reset(metadata: Record<string, string>): void {
  finished.clear(); fs.rmSync(stepsDir, { recursive: true, force: true });
  fs.mkdirSync(stepsDir, { recursive: true, mode: 0o700 }); fs.rmSync(progressLogPath, { force: true }); header(metadata);
}
export function step(name: string, status: 'success' | 'skipped' | 'failed' | 'aborted' | 'interactive', durationMs: number, fields: Record<string, string | number | boolean | undefined>, rawRel?: string): void {
  const duration = durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const details = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => `  ${key.toLowerCase()}: ${secret(key, value)}`);
  append([`=== [${timestamp()}] ${name} [${duration}] → ${status} ===`, ...details, ...(rawRel ? [`  raw: ${rawRel}`] : []), ''].join('\n'));
  if (status === 'success' || status === 'skipped') finished.add(name);
}
export function userInput(key: string, value: string): void { append(`=== [${timestamp()}] user-input → ${key} ===\n  value: ${secret(key, value)}\n`); }
export function complete(totalMs: number): void { append(`## ${timestamp()} · completed (total ${fmtDuration(totalMs).replace(' ', '')})`); }
export function abort(name: string, error: string): void { append(`## ${timestamp()} · aborted at ${name} (${error})`); }
export function stepRawLog(name: string): string {
  fs.mkdirSync(stepsDir, { recursive: true, mode: 0o700 });
  const indices = fs.readdirSync(stepsDir).map((filename) => Number(/^([0-9]+)-/.exec(filename)?.[1] ?? 0));
  const next = String(Math.max(0, ...indices) + 1).padStart(2, '0');
  const label = name.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'step';
  return path.join(stepsDir, `${next}-${label}.log`);
}
