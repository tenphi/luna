/**
 * Measure system-prompt and tool-definition size for the install agent.
 *
 *   luna system-prompt-stats --session --tokens
 *   luna system-prompt-stats --json
 *   luna system-prompt-stats --session-context --session
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { getTheAgent } from '../../bootstrap.js';
import { formatSessionContextHuman, inspectSessionContext } from '../../lib/session-context-stats.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

function measureScriptCommand(scriptPath: string, scriptArgv: string[]): { executable: string; args: string[] } {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return {
    executable: process.execPath,
    args: [tsxCli, scriptPath, ...scriptArgv],
  };
}

function flag(raw: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (raw[key] === true || raw[key] === 'true') return true;
  }
  return false;
}

function resolveAgentGroupId(ctx: CallerContext): string {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  return getTheAgent().id;
}

function buildScriptArgv(raw: Record<string, unknown>): string[] {
  const argv: string[] = [];
  if (typeof raw.inbound === 'string') {
    argv.push('--inbound', raw.inbound);
  }
  if (flag(raw, 'session')) argv.push('--session');
  if (flag(raw, 'no_runtime', 'no-runtime')) argv.push('--no-runtime');
  if (flag(raw, 'no_mcp', 'no-mcp')) argv.push('--no-mcp');
  if (flag(raw, 'tokens')) argv.push('--tokens');
  if (flag(raw, 'json')) argv.push('--json');
  return argv;
}

function sessionContextFromArgs(raw: Record<string, unknown>, ctx: CallerContext) {
  const continuation =
    typeof raw.continuation === 'string'
      ? raw.continuation
      : typeof raw.id === 'string' && raw.id.startsWith('sess-')
        ? raw.id
        : undefined;
  return inspectSessionContext({
    agentGroupId: resolveAgentGroupId(ctx),
    continuation,
    useSession: flag(raw, 'session'),
  });
}

register({
  name: 'system-prompt-stats',
  description:
    'Measure system-prompt and tool-definition size for the install agent; use --session-context to inspect OpenAI continuation history.',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (raw, ctx) => {
    if (flag(raw, 'session_context', 'session-context')) {
      const stats = sessionContextFromArgs(raw, ctx);
      if (flag(raw, 'json')) return stats;
      return formatSessionContextHuman(stats, flag(raw, 'tokens'));
    }

    const scriptPath = path.join(process.cwd(), 'scripts', 'measure-system-prompt.ts');
    const scriptArgv = buildScriptArgv(raw);
    const { executable, args } = measureScriptCommand(scriptPath, scriptArgv);

    try {
      const stdout = execFileSync(executable, args, {
        cwd: process.cwd(),
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
      });

      const trimmed = stdout.trimEnd();
      if (flag(raw, 'json') && scriptArgv.includes('--json')) {
        return JSON.parse(trimmed) as unknown;
      }
      return trimmed;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = (e.stderr || e.stdout || e.message || String(err)).trim();
      throw new Error(detail || 'measure-system-prompt failed', { cause: err });
    }
  },
});
