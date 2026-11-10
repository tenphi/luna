import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ sessions: '', agent: '' }));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    get SESSIONS_DIR() {
      return dirs.sessions;
    },
  };
});
vi.mock('../install-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../install-paths.js')>();
  return { ...actual, getAgentDir: () => dirs.agent };
});

import { ensureSchema, openSessionDb, setSessionState } from '../db/session-db.js';
import { inspectSessionContext } from './session-context-stats.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-session-context-'));
  dirs.sessions = path.join(root, 'sessions');
  dirs.agent = path.join(root, 'agent');
  fs.mkdirSync(path.join(dirs.agent, '.openai-sessions'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('inspectSessionContext', () => {
  it('resolves --session from the newest session.db', () => {
    const sessionDir = path.join(dirs.sessions, 'ag-1', 'sess-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const dbPath = path.join(sessionDir, 'session.db');
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    setSessionState(db, 'continuation:openai', 'cont-1');
    db.close();
    fs.writeFileSync(
      path.join(dirs.agent, '.openai-sessions', 'cont-1.json'),
      JSON.stringify({ messages: [{ role: 'user', content: 'What is on the Household calendar?' }] }),
    );

    const stats = inspectSessionContext({ useSession: true, agentGroupId: 'ag-1' });

    expect(stats).toMatchObject({ sessionId: 'cont-1', continuationSource: 'session.db', messageCount: 1 });
  });

  it('says when the agent has no session.db', () => {
    expect(() => inspectSessionContext({ useSession: true, agentGroupId: 'ag-1' })).toThrow(
      'No session.db found for this agent',
    );
  });
});
