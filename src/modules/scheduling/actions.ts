import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);
function required(content: Record<string, unknown>, key: string): string {
  if (typeof content[key] !== 'string' || !content[key]) throw new Error(`Task action requires ${key}`);
  return content[key] as string;
}
export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  database: Database.Database,
): Promise<void> {
  insertTask(database, {
    id: required(content, 'taskId'),
    processAfter: required(content, 'processAfter'),
    recurrence: optional(content.recurrence) || null,
    platformId: optional(content.platformId),
    channelType: optional(content.channelType),
    threadId: optional(content.threadId),
    content: JSON.stringify({ prompt: required(content, 'prompt'), script: optional(content.script) }),
  });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  database: Database.Database,
): Promise<void> {
  const id = required(content, 'taskId');
  const edits: TaskUpdate = {};
  for (const key of ['prompt', 'processAfter'] as const)
    if (typeof content[key] === 'string') edits[key] = content[key];
  for (const key of ['recurrence', 'script'] as const)
    if (typeof content[key] === 'string' || content[key] === null) edits[key] = content[key] as string | null;
  const matched = database.transaction(() => {
    const count = updateTask(database, id, edits);
    if (count) {
      if (content.status === 'cancelled') cancelTask(database, id);
      if (content.status === 'paused') pauseTask(database, id);
      if (content.status === 'pending') resumeTask(database, id);
    }
    return count;
  })();
  if (matched) return;
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${randomUUID()}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'agent',
    platformId: session.agent_group_id,
    threadId: null,
    content: JSON.stringify({
      text: `update_task: no live task matched id "${id}".`,
      sender: 'system',
      senderId: 'system',
    }),
  });
  const current = getSession(session.id);
  if (current)
    void wakeContainer(current).catch((error) =>
      log.error('Could not notify the agent about a missing task', { error }),
    );
}
