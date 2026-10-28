/**
 * Canonical on-disk data paths under `data/`.
 */
import path from 'path';

export const CENTRAL_DB_FILE = 'luna.db';
export const SESSIONS_DIR_NAME = 'sessions';

export function getCentralDbPath(dataDir: string): string {
  return path.join(dataDir, CENTRAL_DB_FILE);
}

export function getSessionsDir(dataDir: string): string {
  return path.join(dataDir, SESSIONS_DIR_NAME);
}
