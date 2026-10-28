import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { initializeCentralSchema, initializeSessionSchema } from './initialize.js';

const handles: Database.Database[] = [];
const open = () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  handles.push(database);
  return database;
};
afterEach(() => {
  for (const database of handles.splice(0)) database.close();
});

it('creates the complete central schema directly and preserves installed state on reopening', () => {
  const database = open();
  initializeCentralSchema(database);
  database
    .prepare('INSERT INTO agent_groups (id, name, created_at) VALUES (?, ?, ?)')
    .run('fixture-agent', 'Luna', '2031-04-02');
  database.prepare('UPDATE install_settings SET mcp_tool_filters = ? WHERE id = 1').run('{"calendar":["read"]}');
  initializeCentralSchema(database);
  expect(database.pragma('user_version', { simple: true })).toBe(1);
  expect(database.prepare('SELECT name FROM agent_groups').get()).toEqual({ name: 'Luna' });
  expect(database.prepare('SELECT mcp_tool_filters FROM install_settings').get()).toEqual({
    mcp_tool_filters: '{"calendar":["read"]}',
  });
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(tables.map(({ name }) => name)).toContain('reports');
  expect(tables.map(({ name }) => name)).toContain('roster_notices');
  expect(tables.map(({ name }) => name)).not.toContain('schema_version');
  expect(tables.map(({ name }) => name)).not.toContain('user_roles');
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('refuses an unversioned populated database without changing its records or tables', () => {
  const database = open();
  database.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('retained');");
  expect(() => initializeCentralSchema(database)).toThrow('Unsupported Luna database version');
  expect(database.prepare('SELECT * FROM fixture').all()).toEqual([{ value: 'retained' }]);
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'fixture' }]);
  expect(database.pragma('user_version', { simple: true })).toBe(0);
});

it('refuses a future version or damaged schema instead of guessing an upgrade', () => {
  const database = open();
  initializeCentralSchema(database);
  database.pragma('user_version = 2');
  expect(() => initializeCentralSchema(database)).toThrow('Unsupported Luna database version');
  database.pragma('user_version = 1');
  database.exec('DROP TABLE reports');
  expect(() => initializeCentralSchema(database)).toThrow('Database tables do not match');
});

it('starts sessions with all delivery fields and rejects a central database in their place', () => {
  const session = open();
  initializeSessionSchema(session);
  initializeSessionSchema(session);
  const columns = session.prepare('PRAGMA table_info(delivered)').all() as { name: string }[];
  expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining(['resolved_at', 'resolution_reason']));
  expect(session.pragma('user_version', { simple: true })).toBe(1);
  expect(() => initializeCentralSchema(session)).toThrow('Database tables do not match');
});
