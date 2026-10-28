import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { diffLines } from 'diff';
import { AknoError } from '@tenphi/akno-client';
import * as z from 'zod';
import { loadLunaConfig } from '../config/loader.js';
import { getSessionState, insertMessage, markCompleted, setSessionState } from '../db/session-db.js';
import { log } from '../log.js';
import { retryRead } from './client.js';
import { changeDetailsSchema } from './change-diff.js';

const KEY = 'memory:page-watch';
interface WatchedPage {
  text: string | null;
  cursor: number;
}
interface WatchState {
  root?: string;
  pending: string[];
  pages: Record<string, WatchedPage>;
}
export interface MemoryEditContext {
  id: string;
  file: string;
  diff: string;
  truncated: boolean;
}
interface SessionIdentity {
  agentGroupId: string;
  sessionId: string;
}
const observationSchema = z.object({
  relPath: z.string(),
  content: z.string().nullable(),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  transitions: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      actor: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
});
const active = new Map<string, Promise<void>>();
const checks = new Map<string, number>();
const dirty = new Set<string>();
const watches = new Map<string, { watcher: fs.FSWatcher; sessions: Map<string, Set<string>> }>();

function keyOf(session: SessionIdentity): string {
  return `${session.agentGroupId}/${session.sessionId}`;
}
function state(db: Database.Database): WatchState {
  return JSON.parse(getSessionState(db, KEY) ?? '{"pending":[],"pages":{}}') as WatchState;
}
function safePage(file: string): boolean {
  return (
    file.endsWith('.md') &&
    !file.startsWith('conversations/') &&
    !file.includes('\\') &&
    file.split('/').every((part) => part && !part.startsWith('.'))
  );
}

/** Independent of owner-facing receipt settings. A committed write establishes the baseline. */
export function queuePageWatches(db: Database.Database, ids: string[]): void {
  if (loadLunaConfig().memory?.enabled === false) return;
  const value = state(db);
  value.pending = [...new Set([...value.pending, ...ids])];
  setSessionState(db, KEY, JSON.stringify(value));
}

function watch(root: string, session: string, pages: string[]): void {
  for (const [oldRoot, old] of watches) {
    if (oldRoot === root) continue;
    old.sessions.delete(session);
    if (!old.sessions.size) {
      old.watcher.close();
      watches.delete(oldRoot);
    }
  }
  let entry = watches.get(root);
  if (!pages.length) {
    entry?.sessions.delete(session);
    if (entry && !entry.sessions.size) {
      entry.watcher.close();
      watches.delete(root);
    }
    return;
  }
  if (!entry) {
    try {
      const sessions = new Map<string, Set<string>>();
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        const file = filename?.toString();
        for (const [id, paths] of sessions) {
          if (!file || [...paths].some((page) => page === file || page.startsWith(`${file}/`))) dirty.add(id);
        }
      });
      watcher.on('error', () => {
        for (const id of sessions.keys()) dirty.add(id);
        watcher.close();
        if (watches.get(root)?.watcher === watcher) watches.delete(root);
      });
      entry = { watcher, sessions };
      watches.set(root, entry);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Native watch failure falls back to durable reconciliation.
    } catch {
      // The periodic/pre-turn reconciliation remains the correctness path.
      return;
    }
  }
  entry.sessions.set(session, new Set(pages));
}

export function stopMemoryPageWatches(): void {
  for (const entry of watches.values()) entry.watcher.close();
  watches.clear();
  checks.clear();
  dirty.clear();
}

/** Plain literal line diff. Large edits stay explicit about omitted content and can be reread. */
export function memoryEditDiff(
  before: string | null,
  after: string | null,
  limit = 12000,
): { diff: string; truncated: boolean } {
  const parts = diffLines(before ?? '', after ?? '', { timeout: 30, maxEditLength: 2000 }) ?? [
    { value: before ?? '', removed: true },
    { value: after ?? '', added: true },
  ];
  let result = before === null ? '[Page created]\n' : after === null ? '[Page deleted]\n' : '';
  let truncated = false;
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const prefix = part.removed ? '- ' : '+ ';
    const lines = part.value.split('\n');
    if (part.value.endsWith('\n')) lines.pop();
    for (const line of lines) {
      const addition = `${prefix}${line}\n`;
      if (result.length + addition.length > limit) {
        truncated = true;
        break;
      }
      result += addition;
    }
    if (truncated) break;
    if (!part.value.endsWith('\n')) result += '[No newline at end]\n';
  }
  if (truncated)
    result +=
      '[Diff truncated. Use memory_edit_diff with this edit id and offset to read the complete saved change, including removed text; memory_read returns the current page.]';
  return { diff: result, truncated };
}

function queueExternalEdit(db: Database.Database, file: string, before: string | null, after: string | null): void {
  if (before === after) return;
  const edit = { file, ...memoryEditDiff(before, after), fullDiff: memoryEditDiff(before, after, Infinity).diff };
  insertMessage(db, {
    id: `memory-edit:${randomUUID()}`,
    kind: 'memory_edit',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify(edit),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

/** File events are hints. The journal lets all service writes and undos advance the baseline silently. */
export async function reconcileMemoryPages(
  db: Database.Database,
  session: SessionIdentity,
  force = false,
): Promise<void> {
  if (loadLunaConfig().memory?.enabled === false) return;
  const id = keyOf(session);
  if (active.has(id)) return active.get(id)!;
  const saved = state(db);
  if (!saved.pending.length && !Object.keys(saved.pages).length) return;
  if (!force && !saved.pending.length && !dirty.has(id) && Date.now() - (checks.get(id) ?? 0) < 60000) return;
  dirty.delete(id);
  const work = reconcile(db, session).catch((err) => {
    // Leave snapshots/cursors intact on an outage or in-flight mutation. The next pass retries.
    log.debug('watched memory pages could not be reconciled', { err });
    dirty.add(id);
  });
  active.set(id, work);
  try {
    await work;
  } finally {
    active.delete(id);
  }
}

async function reconcile(db: Database.Database, session: SessionIdentity): Promise<void> {
  const value = state(db);
  await retryRead(async (client) => {
    if (!client.hello.features?.includes('page_observations')) return;
    const root = client.hello.akno_path;
    if (value.root && value.root !== root) {
      // A new knowledge base is a different subscription scope, even when page names match.
      value.pages = {};
      const reset = state(db);
      reset.pages = {};
      reset.root = root;
      setSessionState(db, KEY, JSON.stringify(reset));
      db.prepare("DELETE FROM messages_in WHERE kind = 'memory_edit' AND status = 'pending'").run();
    }
    value.root = root;
    const handled = new Set<string>();
    for (const id of value.pending) {
      let details;
      try {
        details = changeDetailsSchema.parse(await client.command('changes', { change_id: id }));
      } catch (err) {
        if (err instanceof AknoError && err.code === 'not_found') {
          handled.add(id);
          continue;
        }
        throw err;
      }
      if (details.id !== id || details.sequence === undefined) throw new Error('invalid watch baseline');
      // An undo before registration is itself feedback. Start at the applied snapshot so the
      // journal can distinguish a human reversal from an agent reversing its own write.
      for (const file of details.files) {
        if (safePage(file.relPath) && !Object.hasOwn(value.pages, file.relPath)) {
          value.pages[file.relPath] = { text: file.after, cursor: details.sequence };
        }
      }
      handled.add(id);
    }
    // Register before reading current text so edits after the baseline cannot escape the next pass.
    watch(root, keyOf(session), Object.keys(value.pages));
    for (const [file, initial] of Object.entries(value.pages)) {
      try {
        let cursor = initial.cursor;
        let text = initial.text;
        const changes: { before: string | null; after: string | null }[] = [];
        let more = true;
        while (more) {
          const observation = observationSchema.parse(
            await client.command('changes', { rel_path: file, after: cursor }),
          );
          if (observation.relPath !== file || observation.cursor < cursor)
            throw new Error('invalid page observation cursor');
          for (const transition of observation.transitions) {
            if (transition.sequence <= cursor || transition.sequence > observation.cursor)
              throw new Error('invalid page transition');
            if (text !== transition.before) changes.push({ before: text, after: transition.before });
            if (transition.actor === 'user' && transition.before !== transition.after) {
              changes.push({ before: transition.before, after: transition.after });
            }
            text = transition.after;
          }
          if (!observation.hasMore && text !== observation.content)
            changes.push({ before: text, after: observation.content });
          if (observation.hasMore && observation.cursor === cursor) throw new Error('page observation did not advance');
          cursor = observation.cursor;
          text = observation.hasMore ? text : observation.content;
          more = observation.hasMore;
        }
        db.transaction(() => {
          for (const change of changes) queueExternalEdit(db, file, change.before, change.after);
          const current = state(db);
          current.root = root;
          current.pages = { ...value.pages, ...current.pages, [file]: { text, cursor } };
          current.pending = current.pending.filter((id) => !handled.has(id));
          setSessionState(db, KEY, JSON.stringify(current));
        })();
        value.pages[file] = { text, cursor };
        // eslint-disable-next-line no-catch-all/no-catch-all -- One unreadable page must not starve other subscriptions.
      } catch (err) {
        log.debug('a watched memory page could not be reconciled', { file, err });
        dirty.add(keyOf(session));
      }
    }

    // Empty/internal-only changes still leave the durable queue.
    const current = state(db);
    current.root = root;
    current.pages = { ...value.pages, ...current.pages };
    current.pending = current.pending.filter((id) => !handled.has(id));
    setSessionState(db, KEY, JSON.stringify(current));
    checks.set(keyOf(session), Date.now());
  });
}

/** Context is read separately from real messages: it neither wakes an agent nor changes routing/topic. */
export async function readMemoryEdits(db: Database.Database, session: SessionIdentity): Promise<MemoryEditContext[]> {
  if (loadLunaConfig().memory?.enabled === false) return [];
  await reconcileMemoryPages(db, session, true);
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE kind = 'memory_edit' AND status = 'pending' ORDER BY seq LIMIT 8",
    )
    .all() as { id: string; content: string }[];
  const edits: MemoryEditContext[] = [];
  let budget = 0;
  for (const row of rows) {
    const content = JSON.parse(row.content) as Omit<MemoryEditContext, 'id'>;
    const edit: MemoryEditContext = {
      id: row.id,
      file: content.file,
      diff: content.diff,
      truncated: content.truncated,
    };
    if (edits.length && budget + edit.diff.length > 24000) break;
    budget += edit.diff.length;
    edits.push(edit);
  }
  return edits;
}

export function acknowledgeMemoryEdits(db: Database.Database, ids: string[]): void {
  const allowed = ids.filter((id) =>
    db.prepare("SELECT 1 FROM messages_in WHERE id = ? AND kind = 'memory_edit'").get(id),
  );
  markCompleted(db, allowed);
}

/** Complete observed changes remain available after acknowledgement, scoped to this session. */
export function readStoredMemoryEdit(
  db: Database.Database,
  id: string,
  offset = 0,
): { file: string; diff: string; nextOffset: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer');
  const row = db.prepare("SELECT content FROM messages_in WHERE id = ? AND kind = 'memory_edit'").get(id) as
    | { content: string }
    | undefined;
  if (!row) throw new Error('No saved external memory edit with that id in this session.');
  const content = JSON.parse(row.content) as { file: string; fullDiff?: string; diff: string };
  const text = content.fullDiff ?? content.diff;
  let start = Math.min(offset, text.length);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')) start--;
  let end = Math.min(start + 12000, text.length);
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  return { file: content.file, diff: text.slice(start, end), nextOffset: end < text.length ? end : null };
}
