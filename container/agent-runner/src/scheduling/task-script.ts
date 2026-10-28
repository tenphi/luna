import { execFile } from 'node:child_process';
import type { MessageInRow } from '../db/messages-in.js';
import { touchHeartbeat } from '../db/connection.js';

export type ScriptResult = { wakeAgent: boolean; data?: unknown };
export type TaskScriptOutcome = { keep: MessageInRow[]; skipped: string[] };

/** Scripts run only inside the isolated agent container, through stdin. */
export function runScript(script: string, taskId: string): Promise<ScriptResult | null> {
  return new Promise((complete) => {
    const child = execFile('bash', ['-s'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 }, (error, stdout, stderr) => {
      if (stderr) console.error(`[task-script] ${taskId}: ${stderr.slice(0, 500)}`);
      if (error) { console.error(`[task-script] ${taskId}: ${error.message}`); complete(null); return; }
      const output = stdout.trimEnd().split('\n').at(-1);
      try {
        const decoded: unknown = JSON.parse(output ?? '');
        complete(decoded && typeof decoded === 'object' && 'wakeAgent' in decoded && typeof decoded.wakeAgent === 'boolean' ? decoded as ScriptResult : null);
      } catch { complete(null); }
    });
    child.stdin?.end(script);
  });
}

export async function applyPreTaskScripts(messages: MessageInRow[]): Promise<TaskScriptOutcome> {
  const result: TaskScriptOutcome = { keep: [], skipped: [] };
  for (const message of messages) {
    let payload: Record<string, unknown> | undefined;
    if (message.kind === 'task') {
      try { const value = JSON.parse(message.content); if (value && typeof value === 'object' && !Array.isArray(value)) payload = value; } catch { /* Let normal message processing report malformed content. */ }
    }
    if (!payload || typeof payload.script !== 'string' || !payload.script) { result.keep.push(message); continue; }
    touchHeartbeat();
    const answer = await runScript(payload.script, message.id);
    touchHeartbeat();
    if (answer?.wakeAgent) result.keep.push({ ...message, content: JSON.stringify({ ...payload, scriptOutput: answer.data ?? null }) });
    else result.skipped.push(message.id);
  }
  return result;
}
