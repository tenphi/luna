/**
 * Session garbage collection.
 *
 * Two independent, always-safe reclaimers:
 *
 *   1. Expired ephemeral sessions — one-shot `luna ask` sessions (ephemeral=1)
 *      whose container has stopped and that haven't been touched within the TTL.
 *      Removes both the DB row and the on-disk folder.
 *
 *   2. Orphan session directories — folders under `data/sessions/<group>/<id>/`
 *      with no matching `sessions` row. These accumulate from `luna db-reset`
 *      (wipes the DB, leaves folders) and any past pruning. Removed on disk.
 *
 * Nothing durable is lost: a live session always has a `sessions` row, so it is
 * never an orphan; and an ephemeral session is only pruned once its container
 * has stopped and it has aged out. Every candidate is re-checked against the DB
 * immediately before deletion to close create/scan races.
 */
import fs from 'fs';
import path from 'path';

import { deleteSession, getSession, getStoppedEphemeralSessions } from './db/sessions.js';
import { parseSqliteUtc } from './host-sweep.js';
import { log } from './log.js';
import { sessionsBaseDir } from './session-manager.js';

/** How long a stopped ephemeral session lingers before it's collected. */
export const DEFAULT_EPHEMERAL_TTL_MS = 60 * 60 * 1000;
/** Session-id prefix guard — never touch a dir that isn't a session folder. */
const SESSION_DIR_PREFIX = 'sess-';

function rmDir(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn('Session GC: failed to remove directory', { dir, err });
    return false;
  }
}

/**
 * Prune ephemeral sessions whose container is stopped and whose last activity
 * (or creation) is older than `ttlMs`. Deletes the folder then the DB row.
 */
export function pruneExpiredEphemeralSessions(ttlMs: number, now = Date.now(), baseDir = sessionsBaseDir()): number {
  let removed = 0;
  for (const session of getStoppedEphemeralSessions()) {
    const stampRaw = session.last_active ?? session.created_at;
    const stamp = parseSqliteUtc(stampRaw);
    if (!Number.isNaN(stamp) && now - stamp < ttlMs) continue;
    rmDir(path.join(baseDir, session.agent_group_id, session.id));
    deleteSession(session.id);
    removed++;
  }
  if (removed > 0) log.info('Session GC: pruned expired ephemeral sessions', { removed });
  return removed;
}

/**
 * Remove on-disk session folders that no longer have a `sessions` row. Also
 * cleans up now-empty agent-group directories.
 */
export function pruneOrphanSessionDirs(baseDir = sessionsBaseDir()): number {
  const base = baseDir;
  let groupDirs: fs.Dirent[];
  try {
    groupDirs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return 0; // sessions dir doesn't exist yet
  }

  let removed = 0;
  for (const group of groupDirs) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(base, group.name);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) continue;
      // Re-check against the DB right before deleting to avoid racing a session
      // that was created after we started scanning.
      if (getSession(entry.name)) continue;
      if (rmDir(path.join(groupPath, entry.name))) removed++;
    }

    // Drop the agent-group folder if it's now empty.
    try {
      if (fs.readdirSync(groupPath).length === 0) fs.rmdirSync(groupPath);
    } catch {
      /* best-effort */
    }
  }

  if (removed > 0) log.info('Session GC: removed orphan session directories', { removed });
  return removed;
}

/**
 * Run a full GC pass. Prune ephemeral sessions first (removes their DB rows),
 * then sweep orphan directories (which also catches the just-freed folders and
 * any historical leftovers).
 */
export function runSessionGc(opts?: { ephemeralTtlMs?: number; now?: number; baseDir?: string }): {
  ephemeralPruned: number;
  orphanDirsRemoved: number;
} {
  const ephemeralTtlMs = opts?.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  const baseDir = opts?.baseDir ?? sessionsBaseDir();
  const ephemeralPruned = pruneExpiredEphemeralSessions(ephemeralTtlMs, opts?.now, baseDir);
  const orphanDirsRemoved = pruneOrphanSessionDirs(baseDir);
  return { ephemeralPruned, orphanDirsRemoved };
}
