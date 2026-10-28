import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { deriveAttachmentName, extForMime } from './attachment-naming.js';
import { isSafeAttachmentName } from './attachment-safety.js';
import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { getSessionsDir } from './data-paths.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  insertMessage,
  insertOutboundMessage,
  openSessionDb,
  upsertSessionRouting,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';

type SessionMode = 'shared' | 'per-thread' | 'agent-shared';
type Input = {
  id: string;
  kind: string;
  timestamp: string;
  content: string;
  platformId?: string | null;
  channelType?: string | null;
  threadId?: string | null;
  processAfter?: string | null;
  recurrence?: string | null;
  trigger?: 0 | 1;
  sourceSessionId?: string | null;
  onWake?: 0 | 1;
};
export const sessionsBaseDir = (): string => getSessionsDir(DATA_DIR);
export function sessionDir(agent: string, session: string): string {
  if (!isSafeAttachmentName(agent) || !isSafeAttachmentName(session))
    throw new Error('Session identity must be a safe path component');
  return path.join(sessionsBaseDir(), agent, session);
}
export const sessionDbPath = (agent: string, session: string): string =>
  path.join(sessionDir(agent, session), 'session.db');
export const openSession = (agent: string, session: string): Database.Database =>
  openSessionDb(sessionDbPath(agent, session));
function withSession<T>(agent: string, session: string, operation: (database: Database.Database) => T): T {
  const database = openSession(agent, session);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
export function initSessionFolder(agent: string, session: string): void {
  fs.mkdirSync(path.join(sessionDir(agent, session), 'outbox'), { recursive: true });
  ensureSchema(sessionDbPath(agent, session));
}
function allocate(
  agent: string,
  group: string | null,
  thread: string | null,
  ephemeral = false,
): { session: Session; created: true } {
  const session: Session = {
    id: `sess-${randomUUID()}`,
    agent_group_id: agent,
    messaging_group_id: group,
    thread_id: thread,
    created_at: new Date().toISOString(),
    last_active: null,
    status: 'active',
    agent_provider: null,
    container_status: 'stopped',
    ...(ephemeral ? { ephemeral: 1 as const } : {}),
  };
  createSession(session);
  initSessionFolder(agent, session.id);
  return { session, created: true };
}
export function resolveSession(
  agent: string,
  group: string | null,
  thread: string | null,
  mode: SessionMode,
): { session: Session; created: boolean } {
  const scopedThread = mode === 'per-thread' ? thread : null;
  const existing =
    mode === 'agent-shared'
      ? findSessionByAgentGroup(agent)
      : group
        ? findSessionForAgent(agent, group, scopedThread)
        : undefined;
  if (!existing) return allocate(agent, group, scopedThread);
  initSessionFolder(agent, existing.id);
  return { session: existing, created: false };
}
export const createEphemeralSession = (
  agent: string,
  group: string | null,
  thread: string | null,
): { session: Session; created: true } => allocate(agent, group, thread, true);
export function writeSessionRouting(agent: string, id: string): void {
  if (!fs.existsSync(sessionDbPath(agent, id))) return;
  const session = getSession(id);
  if (!session) return;
  const origin = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  withSession(agent, id, (database) =>
    upsertSessionRouting(database, {
      platform_id: origin?.platform_id ?? null,
      channel_type: origin?.channel_type ?? null,
      thread_id: session.thread_id,
    }),
  );
}

function contained(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function directoryInside(parent: string, child: string, create: boolean): string | undefined {
  try {
    if (create) fs.mkdirSync(child, { recursive: true });
    const metadata = fs.lstatSync(child);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    const real = fs.realpathSync(child);
    return contained(fs.realpathSync(parent), real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Decode uploads into a host-owned inbox without following container-created links. */
function storeAttachments(agent: string, session: string, id: string, json: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    return json;
  }
  if (!decoded || typeof decoded !== 'object' || !('attachments' in decoded) || !Array.isArray(decoded.attachments))
    return json;
  if (!isSafeAttachmentName(id)) return json;
  const root = sessionDir(agent, session);
  const inbox = directoryInside(root, path.join(root, 'inbox'), true);
  if (!inbox) return json;
  const destination = directoryInside(inbox, path.join(inbox, id), true);
  if (!destination) return json;
  const names = new Set<string>();
  let changed = false;
  for (const value of decoded.attachments) {
    if (!value || typeof value !== 'object' || typeof value.data !== 'string') continue;
    const raw = deriveAttachmentName(value);
    const extension = extForMime(value.mimeType);
    const safe = isSafeAttachmentName(raw) ? raw : `attachment${extension ? '.' + extension : ''}`;
    const suffix = path.extname(safe);
    const stem = safe.slice(0, safe.length - suffix.length);
    let name = safe;
    for (let number = 2; names.has(name); number++) name = `${stem} (${number})${suffix}`;
    names.add(name);
    try {
      fs.writeFileSync(path.join(destination, name), Buffer.from(value.data, 'base64'), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    Object.assign(value, { name, localPath: `inbox/${id}/${name}` });
    delete value.data;
    changed = true;
  }
  return changed ? JSON.stringify(decoded) : json;
}
export function writeSessionMessage(agent: string, session: string, message: Input): void {
  const content = storeAttachments(agent, session, message.id, message.content);
  withSession(agent, session, (database) =>
    insertMessage(database, {
      ...message,
      content,
      platformId: message.platformId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
    }),
  );
  updateSession(session, { last_active: new Date().toISOString() });
}
export function writeOutboundMessage(
  agent: string,
  session: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  withSession(agent, session, (database) =>
    insertOutboundMessage(database, {
      id: message.id,
      kind: message.kind,
      content: message.content,
      channel_type: message.channelType,
      platform_id: message.platformId,
      thread_id: message.threadId,
    }),
  );
}
export function readOutboxFiles(
  agent: string,
  session: string,
  id: string,
  names: string[],
): OutboundFile[] | undefined {
  if (!isSafeAttachmentName(id)) return undefined;
  const base = sessionDir(agent, session);
  const outbox = directoryInside(base, path.join(base, 'outbox'), false);
  const directory = outbox && directoryInside(outbox, path.join(outbox, id), false);
  if (!directory) return undefined;
  const files: OutboundFile[] = [];
  for (const filename of names) {
    if (!isSafeAttachmentName(filename)) continue;
    const file = path.join(directory, filename);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(descriptor);
      const current = fs.lstatSync(file);
      if (
        opened.isFile() &&
        !current.isSymbolicLink() &&
        opened.ino === current.ino &&
        opened.dev === current.dev &&
        contained(directory, fs.realpathSync(file))
      )
        files.push({ filename, data: fs.readFileSync(descriptor) });
    } catch {
      /* A missing or unsafe attachment cannot redirect a host read. */
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return files.length ? files : undefined;
}
/** Cleanup cannot fail a delivery that the recipient has already received. */
export function clearOutbox(agent: string, session: string, id: string): void {
  if (!isSafeAttachmentName(id)) return;
  try {
    const base = sessionDir(agent, session);
    const outbox = directoryInside(base, path.join(base, 'outbox'), false);
    const directory = outbox && directoryInside(outbox, path.join(outbox, id), false);
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    log.warn('Delivered attachment cleanup failed', { error });
  }
}
export function markContainerRunning(id: string): void {
  updateSession(id, { last_active: new Date().toISOString(), container_status: 'running' });
}
export function markContainerStopped(id: string): void {
  updateSession(id, { container_status: 'stopped' });
}

/** Stage a host-read file for another session using the same directory checks as uploads. */
export function stageInboxFile(
  agent: string,
  session: string,
  message: string,
  file: OutboundFile,
): string | undefined {
  if (!isSafeAttachmentName(message) || !isSafeAttachmentName(file.filename)) return;
  const base = sessionDir(agent, session);
  const inbox = directoryInside(base, path.join(base, 'inbox'), true);
  const destination = inbox && directoryInside(inbox, path.join(inbox, message), true);
  if (!destination) return;
  const target = path.join(destination, file.filename);
  try {
    fs.writeFileSync(target, file.data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const metadata = fs.lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
  }
  return `inbox/${message}/${file.filename}`;
}
