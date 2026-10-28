import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence } from './db.js';

/** Advance each completed series atomically so a failed insertion cannot lose its schedule. */
export async function handleRecurrence(database: Database.Database, session: Session): Promise<void> {
  for (const completed of getCompletedRecurring(database)) {
    try {
      const next = CronExpressionParser.parse(completed.recurrence, { tz: TIMEZONE }).next().toISOString();
      database.transaction(() => {
        insertRecurrence(database, completed, `${completed.kind === 'task' ? 'task' : 'msg'}-${randomUUID()}`, next);
        clearRecurrence(database, completed.id);
      })();
    } catch (error) {
      log.error('A recurring item could not be advanced', { id: completed.id, session: session.id, error });
    }
  }
}
