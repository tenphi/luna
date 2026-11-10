import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  initTestDb,
  closeDb,
  initializeCentralSchema,
  createAgentGroup,
  createSession,
  getSession,
} from './db/index.js';
import { pruneExpiredEphemeralSessions, pruneOrphanSessionDirs } from './session-gc.js';
import type { Session } from './types.js';

let baseDir: string;

function makeSession(over: Partial<Session>): Session {
  return {
    id: 'sess-x',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    ephemeral: 0,
    ...over,
  };
}

function mkSessionDir(id: string, group = 'ag-1'): string {
  const dir = path.join(baseDir, group, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.db'), '');
  return dir;
}

beforeEach(() => {
  const db = initTestDb();
  initializeCentralSchema(db);
  createAgentGroup({ id: 'ag-1', name: 'Test', agent_provider: null, created_at: new Date().toISOString() });
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-gc-'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('pruneOrphanSessionDirs', () => {
  it('removes dirs with no DB row, keeps referenced ones, and cleans empty group dirs', () => {
    createSession(makeSession({ id: 'sess-keep' }));
    mkSessionDir('sess-keep');
    mkSessionDir('sess-orphan1');
    mkSessionDir('sess-orphan2', 'ag-old'); // whole group becomes orphaned

    const removed = pruneOrphanSessionDirs(baseDir);

    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(baseDir, 'ag-1', 'sess-keep'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'ag-1', 'sess-orphan1'))).toBe(false);
    // the ag-old group had only an orphan and should be removed entirely
    expect(fs.existsSync(path.join(baseDir, 'ag-old'))).toBe(false);
  });

  it('ignores directories that are not session folders', () => {
    fs.mkdirSync(path.join(baseDir, 'ag-1', 'not-a-session'), { recursive: true });
    const removed = pruneOrphanSessionDirs(baseDir);
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(baseDir, 'ag-1', 'not-a-session'))).toBe(true);
  });
});

describe('pruneExpiredEphemeralSessions', () => {
  it('removes only stopped ephemeral sessions past the TTL', () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    createSession(makeSession({ id: 'sess-eph-old', ephemeral: 1, created_at: old }));
    mkSessionDir('sess-eph-old');
    createSession(makeSession({ id: 'sess-eph-recent', ephemeral: 1, created_at: recent }));
    mkSessionDir('sess-eph-recent');
    createSession(makeSession({ id: 'sess-eph-running', ephemeral: 1, created_at: old, container_status: 'running' }));
    mkSessionDir('sess-eph-running');
    createSession(makeSession({ id: 'sess-persistent', ephemeral: 0, created_at: old }));
    mkSessionDir('sess-persistent');

    const removed = pruneExpiredEphemeralSessions(60 * 60 * 1000, Date.now(), baseDir);

    expect(removed).toBe(1);
    expect(getSession('sess-eph-old')).toBeUndefined();
    expect(fs.existsSync(path.join(baseDir, 'ag-1', 'sess-eph-old'))).toBe(false);
    // recent ephemeral, running ephemeral, and persistent all survive
    expect(getSession('sess-eph-recent')).toBeDefined();
    expect(getSession('sess-eph-running')).toBeDefined();
    expect(getSession('sess-persistent')).toBeDefined();
  });
});
