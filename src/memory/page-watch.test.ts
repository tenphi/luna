import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AknoError } from '@tenphi/akno-client';
const service = vi.hoisted(() => ({
  root: '',
  enabled: true,
  notify: 'pages',
  features: ['change_details', 'page_observations'],
  command: vi.fn(),
}));
vi.mock('../config/loader.js', () => ({
  loadLunaConfig: () => ({ memory: { enabled: service.enabled, notify: service.notify } }),
}));
vi.mock('./client.js', () => ({
  retryRead: (work: (client: unknown) => Promise<unknown>) =>
    work({ hello: { features: service.features, akno_path: service.root }, command: service.command }),
}));
vi.mock('../session-manager.js', () => ({
  openSession: vi.fn(),
  sessionDbPath: () => '/nonexistent/fixture/session.db',
}));
import {
  ensureSchema,
  openSessionDb,
  getSessionState,
  getPendingForContainer,
  countDueMessages,
  insertMessage,
} from '../db/session-db.js';
import {
  acknowledgeMemoryEdits,
  memoryEditDiff,
  queuePageWatches,
  readMemoryEdits,
  readStoredMemoryEdit,
  reconcileMemoryPages,
  stopMemoryPageWatches,
} from './page-watch.js';
import { queueMemoryChanges } from './change-notifications.js';
let root: string;
let db: Database.Database;
let text: string | null;
let cursor: number;
let transitions: { sequence: number; actor: string; before: string | null; after: string | null }[];
const session = { agentGroupId: 'fixture-agent', sessionId: 'fixture-session' };
const file = 'notes/preferences.md';
const initial = 'Prefers morning meetings.\n';
function state() {
  return JSON.parse(getSessionState(db, 'memory:page-watch')!);
}
function baseline(id: string) {
  return {
    id,
    sequence: 1,
    status: 'applied',
    files: [{ relPath: file, action: 'modified', before: 'Meeting preferences.\n', after: initial }],
  };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-page-watch-'));
  service.root = path.join(root, 'kb');
  fs.mkdirSync(path.join(service.root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(service.root, file), initial);
  ensureSchema(path.join(root, 'session.db'));
  db = openSessionDb(path.join(root, 'session.db'));
  text = initial;
  cursor = 1;
  transitions = [];
  service.enabled = true;
  service.notify = 'pages';
  service.features = ['change_details', 'page_observations'];
  service.command.mockReset().mockImplementation(async (_command, input) =>
    input.change_id
      ? baseline(input.change_id)
      : {
          relPath: input.rel_path,
          content: text,
          cursor,
          hasMore: false,
          transitions: transitions.filter((item) => item.sequence > input.after),
        },
  );
});
afterEach(() => {
  stopMemoryPageWatches();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
async function subscribe() {
  queuePageWatches(db, ['chg_fixture']);
  await reconcileMemoryPages(db, session);
}
describe('human memory edit context', () => {
  it('subscribes with receipts off and keeps edits out of real message polling and wake counts', async () => {
    service.notify = 'off';
    expect(queueMemoryChanges(db, { outcome: 'ok', change_id: 'chg_fixture' })).toBe(false);
    await reconcileMemoryPages(db, session);
    text = 'Prefers afternoon meetings.\n';
    const edits = await readMemoryEdits(db, session);
    expect(edits).toEqual([
      expect.objectContaining({ file, diff: '- Prefers morning meetings.\n+ Prefers afternoon meetings.\n' }),
    ]);
    expect(getPendingForContainer(db, false, 10)).toEqual([]);
    expect(countDueMessages(db)).toBe(0);
  });
  it('survives restarts, does not replay observed diffs, and acknowledges only the supplied edits', async () => {
    await subscribe();
    text = 'Afternoon meetings.\n';
    const [first] = await readMemoryEdits(db, session);
    db.close();
    stopMemoryPageWatches();
    db = openSessionDb(path.join(root, 'session.db'));
    expect(await readMemoryEdits(db, session)).toHaveLength(1);
    text = 'Evening meetings.\n';
    expect(await readMemoryEdits(db, session)).toHaveLength(2);
    acknowledgeMemoryEdits(db, [first.id, 'not-a-context-row']);
    expect(await readMemoryEdits(db, session)).toEqual([
      expect.objectContaining({ diff: expect.stringContaining('+ Evening meetings.') }),
    ]);
  });
  it('reports a human undo even when it happens before the first watch registration', async () => {
    text = 'Meeting preferences.\n';
    cursor = 2;
    transitions = [{ sequence: 2, actor: 'user', before: initial, after: text }];
    service.command.mockImplementationOnce(async () => ({ ...baseline('chg_fixture'), status: 'undone' }));
    queuePageWatches(db, ['chg_fixture']);
    const edits = await readMemoryEdits(db, session);
    expect(edits[0].diff).toBe('- Prefers morning meetings.\n+ Meeting preferences.\n');
  });
  it('silently advances across writes from other sessions, maintenance, and undos', async () => {
    await subscribe();
    transitions = [
      { sequence: 2, actor: 'agent', before: initial, after: 'Service rewrite.\n' },
      { sequence: 3, actor: 'agent', before: 'Service rewrite.\n', after: initial },
    ];
    cursor = 3;
    expect(await readMemoryEdits(db, session)).toEqual([]);
    expect(state().pages[file]).toEqual({ text: initial, cursor: 3 });
    text = 'User correction.\n';
    expect((await readMemoryEdits(db, session))[0].diff).not.toContain('Service rewrite');
  });
  it('finds a human edit captured before a later agent write and a further human correction', async () => {
    await subscribe();
    const external = 'Human correction.\n';
    const agent = 'Agent append.\n';
    transitions = [{ sequence: 2, actor: 'agent', before: external, after: agent }];
    cursor = 2;
    text = 'Further correction.\n';
    const edits = await readMemoryEdits(db, session);
    expect(edits.map((edit) => edit.diff)).toEqual([
      '- Prefers morning meetings.\n+ Human correction.\n',
      '- Agent append.\n+ Further correction.\n',
    ]);
  });
  it('captures deletion and recreation while leaving an empty page distinct from a missing page', async () => {
    await subscribe();
    text = null;
    expect((await readMemoryEdits(db, session))[0].diff).toContain('[Page deleted]');
    text = '';
    expect((await readMemoryEdits(db, session))[1].diff).toBe('[Page created]\n');
  });
  it('retains cursors on service failure, and retries a change exactly once', async () => {
    await subscribe();
    text = 'A correction.\n';
    service.command.mockRejectedValueOnce(new AknoError('busy', 'write committing'));
    expect(await readMemoryEdits(db, session)).toEqual([]);
    expect(state().pages[file].text).toBe(initial);
    expect(await readMemoryEdits(db, session)).toHaveLength(1);
    expect(await readMemoryEdits(db, session)).toHaveLength(1);
  });
  it('reports explicit human writes through the service while suppressing agent writes', async () => {
    await subscribe();
    text = 'A correction through the human CLI.\n';
    cursor = 2;
    transitions = [{ sequence: 2, actor: 'user', before: initial, after: text }];
    expect((await readMemoryEdits(db, session))[0].diff).toContain('+ A correction through the human CLI.');
  });
  it('does not discard new receipts queued while reading file state', async () => {
    await subscribe();
    service.command.mockImplementationOnce(async (_command, input) => {
      queuePageWatches(db, ['chg_new']);
      return { relPath: input.rel_path, content: text, cursor, hasMore: false, transitions: [] };
    });
    await readMemoryEdits(db, session);
    expect(state().pending).toEqual(['chg_new']);
  });
  it('pages through service history before comparing the final live text', async () => {
    await subscribe();
    text = 'After own writes.\n';
    cursor = 3;
    service.command.mockImplementationOnce(async (_command, input) => ({
      relPath: input.rel_path,
      content: text,
      cursor: 2,
      hasMore: true,
      transitions: [{ sequence: 2, actor: 'agent', before: initial, after: 'First write.\n' }],
    }));
    service.command.mockImplementationOnce(async (_command, input) => ({
      relPath: input.rel_path,
      content: text,
      cursor: 3,
      hasMore: false,
      transitions: [{ sequence: 3, actor: 'agent', before: 'First write.\n', after: text }],
    }));
    expect(await readMemoryEdits(db, session)).toEqual([]);
  });
  it('uses native atomic-save events to invalidate a recent reconciliation', async () => {
    await subscribe();
    text = 'External atomic save.\n';
    const target = path.join(service.root, file);
    fs.writeFileSync(`${target}.tmp`, text);
    fs.renameSync(`${target}.tmp`, target);
    await vi.waitFor(
      async () => {
        await reconcileMemoryPages(db, session);
        expect(db.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'memory_edit'").get()).toEqual({
          count: 1,
        });
      },
      { timeout: 3000, interval: 50 },
    );
  });
  it('supports disabled memory and old services without fabricating context or losing subscriptions', async () => {
    service.features = ['change_details'];
    queuePageWatches(db, ['chg_fixture']);
    expect(await readMemoryEdits(db, session)).toEqual([]);
    expect(state().pending).toEqual(['chg_fixture']);
    service.features.push('page_observations');
    await subscribe();
    text = 'User correction.\n';
    service.enabled = false;
    expect(await readMemoryEdits(db, session)).toEqual([]);
    service.enabled = true;
    expect(await readMemoryEdits(db, session)).toHaveLength(1);
  });
  it('does not subscribe to conversation mirrors or unsafe paths', async () => {
    service.command.mockResolvedValueOnce({
      ...baseline('chg_fixture'),
      files: ['conversations/topic.md', '../private.md', '/private.md', '.hidden/note.md'].map((relPath) => ({
        relPath,
        action: 'modified',
        before: '',
        after: '',
      })),
    });
    await subscribe();
    expect(state().pages).toEqual({});
    expect(state().pending).toEqual([]);
  });
  it('isolates observations and context between sessions subscribed to different pages', async () => {
    await subscribe();
    const otherPath = path.join(root, 'other.db');
    ensureSchema(otherPath);
    const other = openSessionDb(otherPath);
    try {
      text = 'Private fixture correction.\n';
      expect(await readMemoryEdits(db, session)).toHaveLength(1);
      expect(await readMemoryEdits(other, { ...session, sessionId: 'other' })).toEqual([]);
    } finally {
      other.close();
    }
  });
  it('clears old subscriptions and pending context when the knowledge-base root changes', async () => {
    await subscribe();
    text = 'Old root correction.\n';
    expect(await readMemoryEdits(db, session)).toHaveLength(1);
    service.root = path.join(root, 'new-kb');
    fs.mkdirSync(service.root);
    expect(await readMemoryEdits(db, session)).toEqual([]);
    expect(state().pages).toEqual({});
  });
  it('does not acknowledge ordinary user messages through the context endpoint', () => {
    insertMessage(db, {
      id: 'user-message',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'fixture',
      channelType: 'telegram',
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
    });
    acknowledgeMemoryEdits(db, ['user-message']);
    expect(countDueMessages(db)).toBe(1);
  });
  it('preserves the complete removed text of large edits and paginates it after acknowledgement', async () => {
    await subscribe();
    text = '🌙'.repeat(14000) + '\n';
    const [edit] = await readMemoryEdits(db, session);
    expect(edit.truncated).toBe(true);
    expect(edit).not.toHaveProperty('fullDiff');
    acknowledgeMemoryEdits(db, [edit.id]);
    let offset: number | null = 0;
    let complete = '';
    while (offset !== null) {
      const chunk = readStoredMemoryEdit(db, edit.id, offset);
      expect(chunk.diff.length).toBeLessThanOrEqual(12000);
      complete += chunk.diff;
      offset = chunk.nextOffset;
    }
    expect(complete).toBe(memoryEditDiff(initial, text, Infinity).diff);
    expect(() => readStoredMemoryEdit(db, 'another-session-edit')).toThrow('this session');
  });
  it('marks large diffs as incomplete and preserves newline-only changes and Unicode', () => {
    expect(memoryEditDiff('Text\n', 'Text').diff).toContain('[No newline at end]');
    expect(memoryEditDiff('🌙\n', '🌞\n').diff).toBe('- 🌙\n+ 🌞\n');
    const huge = memoryEditDiff('a'.repeat(50000), 'b'.repeat(50000));
    expect(huge.truncated).toBe(true);
    expect(huge.diff).toContain('memory_read');
    expect(huge.diff.length).toBeLessThan(12300);
  });
});
