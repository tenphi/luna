import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { AknoError } from '@tenphi/akno-client';

import { loadLunaConfig } from '../config/loader.js';
import { getSessionRoutingRow, getSessionState, insertOutboundMessage, setSessionState } from '../db/session-db.js';
import { currentCaller } from '../host-mcp/caller-context.js';
import { log } from '../log.js';
import { openSession, sessionDbPath } from '../session-manager.js';
import { retryRead } from './client.js';
import { queuePageWatches } from './page-watch.js';
import { changeDetailsSchema, formatMemoryPath, renderChangeDiff } from './change-diff.js';

const PENDING_KEY = 'memory:change-notifications';
interface PendingChange {
  id: string;
  slugs: string[];
  routing?: { channel_type: string | null; platform_id: string | null; thread_id: string | null };
}

function pendingChanges(db: Database.Database): PendingChange[] {
  const value = getSessionState(db, PENDING_KEY);
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is PendingChange =>
      typeof entry?.id === 'string' &&
      Array.isArray(entry.slugs) &&
      entry.slugs.every((slug: unknown) => typeof slug === 'string'),
  );
}

export function hasPendingMemoryChanges(db: Database.Database): boolean {
  return pendingChanges(db).length > 0;
}

/** Only journal identities are queued; snapshots remain owned by Akno until delivery. */
export function queueMemoryChanges(db: Database.Database, receipt: unknown): boolean {
  const value = receipt as {
    change_id?: unknown;
    change_ids?: unknown;
    outcome?: unknown;
    wrote?: unknown;
    candidates?: unknown;
  } | null;
  if (!value || ['noop', 'held', 'conflict', 'requires_approval', 'requires_folder'].includes(String(value.outcome)))
    return false;
  const ids = [
    ...new Set([
      ...(Array.isArray(value.change_ids) ? value.change_ids.filter((id): id is string => typeof id === 'string') : []),
      ...(typeof value.change_id === 'string' ? [value.change_id] : []),
    ]),
  ].filter(Boolean);
  if (ids.length === 0) return false;
  queuePageWatches(db, ids);
  if (loadLunaConfig().memory?.notify === 'off') return false;
  const slugs = Array.isArray(value.wrote)
    ? value.wrote.map((item) => item?.slug).filter((slug): slug is string => typeof slug === 'string')
    : Array.isArray(value.candidates)
      ? value.candidates
          .filter((item) => ['written', 'support_added'].includes(item?.outcome))
          .map((item) => item?.slug)
          .filter((slug): slug is string => typeof slug === 'string')
      : [];
  const pending = pendingChanges(db);
  const routing = getSessionRoutingRow(db);
  for (const id of ids) if (!pending.some((entry) => entry.id === id)) pending.push({ id, slugs, routing });
  setSessionState(db, PENDING_KEY, JSON.stringify(pending));
  return true;
}

/** A successful mutation must stay successful even when its notification cannot be queued. */
export function queueCallerMemoryChanges(receipt: unknown): void {
  const caller = currentCaller();
  if (!caller?.sessionId) return;
  try {
    if (
      [caller.agentGroupId, caller.sessionId].some((id) => !id || id === '.' || id === '..' || path.basename(id) !== id)
    )
      return;
    if (!fs.existsSync(sessionDbPath(caller.agentGroupId, caller.sessionId))) return;
    const db = openSession(caller.agentGroupId, caller.sessionId);
    try {
      queueMemoryChanges(db, receipt);
    } finally {
      db.close();
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- Receipt storage must never fail an already committed mutation.
  } catch (err) {
    log.warn('could not queue a memory change receipt', { err });
  }
}

/** Drain only while the session is idle, including sessions with automatic learning disabled. */
export async function deliverMemoryChanges(db: Database.Database): Promise<void> {
  const pending = pendingChanges(db);
  if (pending.length === 0) return;
  if (loadLunaConfig().memory?.notify === 'off') {
    setSessionState(db, PENDING_KEY, '[]');
    return;
  }
  for (const entry of pending) {
    const routing = entry.routing?.channel_type && entry.routing.platform_id ? entry.routing : getSessionRoutingRow(db);
    if (!routing.channel_type || !routing.platform_id) continue;
    let messages: string[];
    try {
      messages = await retryRead(async (client) => {
        if (!client.hello.features?.includes('change_details')) {
          const slugs = entry.slugs.filter((slug) => !slug.startsWith('conversations/'));
          if (entry.slugs.length && !slugs.length) return [];
          const names = slugs.slice(0, 3).map(formatMemoryPath).join(', ');
          const rest = slugs.length > 3 ? ` and ${slugs.length - 3} more pages` : '';
          return [
            `🧠 Memory changed${slugs.length ? `: ${names}${rest}` : ''}.\n\nThe diff is unavailable until Akno supports change details.`,
          ];
        }
        const change = changeDetailsSchema.parse(await client.command('changes', { change_id: entry.id }));
        if (change.id !== entry.id) throw new Error('memory returned a different journal change');
        return change.status === 'undone' ? [] : renderChangeDiff(change);
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- All read failures retain the durable identity for retry, including invalid snapshots.
    } catch (err) {
      if (err instanceof AknoError && err.code === 'not_found') {
        messages = ['🧠 Memory changed. The saved diff is no longer available.'];
      } else {
        log.warn('memory change details are unavailable; receipt remains queued', { changeId: entry.id, err });
        return;
      }
    }
    db.transaction(() => {
      messages.forEach((text, index) =>
        insertOutboundMessage(db, {
          id: `memory-change:${entry.id}:${index}`,
          kind: 'chat',
          channel_type: routing.channel_type,
          platform_id: routing.platform_id,
          thread_id: routing.thread_id,
          content: JSON.stringify({ type: 'memory_change', text, memoryChangeId: entry.id }),
        }),
      );
      // Re-read so a new tool receipt arriving during the service read is not discarded.
      setSessionState(db, PENDING_KEY, JSON.stringify(pendingChanges(db).filter((item) => item.id !== entry.id)));
    })();
  }
}
