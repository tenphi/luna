import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { detectRegisteredGroups, readEnvKey } from './environment.js';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-onboarding-contract-')); fs.mkdirSync(path.join(directory, 'data')); });
afterEach(() => fs.rmSync(directory, { recursive: true }));
it('reads a quoted credential only from the requested installation', () => {
  fs.writeFileSync(path.join(directory, '.env'), 'EXAMPLE_TOKEN="synthetic-value"\n');
  expect(readEnvKey('EXAMPLE_TOKEN', directory)).toBe('synthetic-value');
  expect(readEnvKey('OTHER_KEY', directory)).toBeNull();
});
it('recognizes only a wired agent in the current central database', () => {
  expect(detectRegisteredGroups(directory)).toBe(false);
  const database = new Database(path.join(directory, 'data', 'luna.db'));
  database.exec('CREATE TABLE agent_groups(id TEXT PRIMARY KEY); CREATE TABLE messaging_group_agents(agent_group_id TEXT);');
  expect(detectRegisteredGroups(directory)).toBe(false);
  database.prepare('INSERT INTO agent_groups VALUES(?)').run('fixture-agent');
  database.prepare('INSERT INTO messaging_group_agents VALUES(?)').run('fixture-agent');
  expect(detectRegisteredGroups(directory)).toBe(true); database.close();
});
it('treats an unmigrated database as an unfinished installation', () => {
  const database = new Database(path.join(directory, 'data', 'luna.db')); database.close();
  expect(detectRegisteredGroups(directory)).toBe(false);
});
