import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let central: Database.Database | undefined;

function open(filename: string): Database.Database {
  if (central?.open) central.close();
  central = new Database(filename);
  central.pragma('foreign_keys=ON');
  if (filename !== ':memory:') central.pragma('journal_mode=WAL');
  return central;
}

export function getDb(): Database.Database {
  if (central?.open) return central;
  throw new Error('Database not initialized. Call initDb() first.');
}

export function initDb(filename: string): Database.Database {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return open(filename);
}
export const initTestDb = (): Database.Database => open(':memory:');
export function closeDb(): void {
  if (central?.open) central.close();
  central = undefined;
}
