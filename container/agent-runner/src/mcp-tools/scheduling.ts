import { createHash, randomUUID } from 'node:crypto';
import { getSessionClient } from '../session/client.js';
import { getCurrentInReplyTo, getCurrentTaskRun } from '../current-batch.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const receipt = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const failure = (text: string) => ({ ...receipt(`Error: ${text}`), isError: true });
const normalized = (text: string): string => text.trim().replace(/\s+/g, ' ');
const string = (description: string) => ({ type: 'string', description });
const states = ['pending', 'paused', 'cancelled'];

function instant(input: string): string | undefined {
  try { return parseZonedToUtc(input, TIMEZONE).toISOString(); } catch { return undefined; }
}
function identity(prompt: string, when: string, recurrence: string | null, script: string | null): string {
  const batch = getCurrentInReplyTo();
  const suffix = batch ? createHash('sha256').update(JSON.stringify([batch, normalized(prompt), when, recurrence, script])).digest('hex').slice(0, 32) : randomUUID();
  return `task-${suffix}`;
}
async function action(id: string, payload: Record<string, unknown>, route?: Awaited<ReturnType<typeof getSessionRouting>>): Promise<void> {
  await writeMessageOut({ id, kind: 'system', content: JSON.stringify(payload), ...(route ?? {}) });
}

export const scheduleTask: McpToolDefinition = {
  tool: { name: 'schedule_task', description: 'Wake Luna later for a task, optionally repeating on a cron schedule.', inputSchema: {
    type: 'object', properties: {
      prompt: string('Instructions for the future run'),
      processAfter: string('First run as an ISO timestamp. A time without an offset uses the install time zone.'),
      recurrence: string('Optional cron schedule interpreted in the install time zone'),
      script: string('Optional container shell script returning a wakeAgent boolean in its last JSON line'),
    }, required: ['prompt', 'processAfter'],
  } },
  async handler(args) {
    if (typeof args.prompt !== 'string' || !args.prompt || typeof args.processAfter !== 'string' || !args.processAfter) return failure('prompt and processAfter are required');
    const when = instant(args.processAfter);
    if (!when) return failure(`invalid processAfter: ${args.processAfter}`);
    const repeat = typeof args.recurrence === 'string' && args.recurrence ? args.recurrence : null;
    const script = typeof args.script === 'string' && args.script ? args.script : null;
    const current = getCurrentTaskRun();
    if (current && repeat && current.recurrence === repeat && normalized(current.prompt) === normalized(args.prompt)) {
      return receipt(`This recurring task is already running (series id: ${current.seriesId}). Do not schedule a copy; use update_task to change it.`);
    }
    const saved = (await getSessionClient().listTasks()).find((task) => {
      try {
        const payload = JSON.parse(task.content);
        return normalized(payload.prompt ?? '') === normalized(args.prompt as string) && (task.recurrence ?? null) === repeat && (payload.script ?? null) === script;
      } catch { return false; }
    });
    if (saved) return receipt(`This task already exists (series id: ${saved.id}, next run: ${saved.process_after ?? 'now'}). Use update_task to change it.`);
    const route = await getSessionRouting();
    const id = identity(args.prompt, when, repeat, script);
    await action(id, {
      action: 'schedule_task', taskId: id, prompt: args.prompt, script, processAfter: when, recurrence: repeat,
      channelType: route.channel_type, platformId: route.platform_id, threadId: route.thread_id,
    }, route);
    return receipt(`Task scheduled (id: ${id}, runs at: ${when}${repeat ? `, recurrence: ${repeat}` : ''})`);
  },
};

export const listTasks: McpToolDefinition = {
  tool: { name: 'list_tasks', description: 'Show the live occurrence of each task series; use its id with update_task.', inputSchema: {
    type: 'object', properties: { status: string('Limit results to pending or paused; omission includes both') },
  } },
  async handler(args) {
    const tasks = await getSessionClient().listTasks(typeof args.status === 'string' ? args.status : undefined);
    const lines: string[] = [];
    for (const task of tasks) {
      const payload = JSON.parse(task.content);
      lines.push(`- ${task.id} [${task.status}] at=${task.process_after || 'now'} ${task.recurrence ? `recur=${task.recurrence} ` : ''}→ ${String(payload.prompt ?? '').slice(0, 80)}`);
    }
    return receipt(lines.join('\n') || 'No tasks found.');
  },
};

export const updateTask: McpToolDefinition = {
  tool: { name: 'update_task', description: 'Change task instructions, timing, or status. Leave fields out to preserve them.', inputSchema: {
    type: 'object', properties: {
      taskId: string('Stable series identifier from list_tasks'), prompt: string('Replacement instructions'),
      processAfter: string('Replacement first-run timestamp, interpreted in the install zone when no offset is given'),
      recurrence: string('Replacement cron expression; an empty string removes repetition'),
      script: string('Replacement pre-task script; an empty string removes it'),
      status: { type: 'string', enum: states, description: 'pending resumes, paused suspends, cancelled ends the series' },
    }, required: ['taskId'],
  } },
  async handler(args) {
    if (typeof args.taskId !== 'string' || !args.taskId) return failure('taskId is required');
    const changed: Record<string, unknown> = {};
    for (const key of ['prompt', 'script', 'recurrence']) if (typeof args[key] === 'string') changed[key] = key !== 'prompt' && args[key] === '' ? null : args[key];
    if (typeof args.processAfter === 'string') {
      const when = instant(args.processAfter);
      if (!when) return failure(`invalid processAfter: ${args.processAfter}`);
      changed.processAfter = when;
    }
    if (args.status !== undefined) {
      if (typeof args.status !== 'string' || !states.includes(args.status)) return failure(`invalid status: ${String(args.status)}. Use ${states.join(', ')}.`);
      changed.status = args.status;
    }
    if (!Object.keys(changed).length) return failure('at least one field to update is required');
    await action(`sys-${randomUUID()}`, { action: 'update_task', taskId: args.taskId, ...changed });
    return receipt(`Task update requested: ${args.taskId}`);
  },
};
registerTools([scheduleTask, listTasks, updateTask]);
