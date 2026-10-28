import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AknoError } from '@tenphi/akno-client';

const service = vi.hoisted(() => ({
  notify: 'pages',
  features: ['change_details'],
  command: vi.fn(),
}));
vi.mock('../config/loader.js', () => ({ loadLunaConfig: () => ({ memory: { notify: service.notify } }) }));
vi.mock('./client.js', () => ({
  retryRead: (work: (client: unknown) => Promise<unknown>) =>
    work({ hello: { features: service.features }, command: service.command }),
}));
vi.mock('../session-manager.js', () => ({
  openSession: vi.fn(),
  sessionDbPath: () => '/nonexistent/fixture/session.db',
}));

import { ensureSchema, getSessionState, openSessionDb, upsertSessionRouting } from '../db/session-db.js';
import { deliverMemoryChanges, hasPendingMemoryChanges, queueMemoryChanges } from './change-notifications.js';

let root: string;
let db: Database.Database;
function rows() {
  return (
    db.prepare('SELECT content, platform_id FROM messages_out ORDER BY seq').all() as {
      content: string;
      platform_id: string;
    }[]
  ).map((row) => ({ ...JSON.parse(row.content), platform: row.platform_id }));
}
function details(id = 'chg_fixture') {
  return {
    id,
    status: 'applied',
    files: [
      {
        relPath: 'notes/preferences.md',
        action: 'modified',
        before: 'Prefers morning meetings.\n',
        after: 'Prefers afternoon meetings.\n',
      },
    ],
  };
}
function receipt(id = 'chg_fixture') {
  return { outcome: 'ok', change_id: id, wrote: [{ slug: 'notes/preferences' }] };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-change-receipt-'));
  const file = path.join(root, 'session.db');
  ensureSchema(file);
  db = openSessionDb(file);
  upsertSessionRouting(db, { channel_type: 'telegram', platform_id: 'fixture-dm', thread_id: null });
  service.notify = 'pages';
  service.features = ['change_details'];
  service.command.mockReset().mockImplementation(async (_command, input) => details(input.change_id));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('durable memory receipts', () => {
  it('survives a host restart and queues an exact receipt once across replay', async () => {
    queueMemoryChanges(db, receipt());
    db.close();
    db = openSessionDb(path.join(root, 'session.db'));
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([
      expect.objectContaining({
        type: 'memory_change',
        memoryChangeId: 'chg_fixture',
        text: expect.stringContaining('- Prefers morning meetings.\n+ Prefers afternoon meetings.'),
      }),
    ]);
    expect(rows()[0].text).toContain('**Page** · line 1');
    expect(hasPendingMemoryChanges(db)).toBe(false);
    queueMemoryChanges(db, receipt());
    await deliverMemoryChanges(db);
    expect(rows()).toHaveLength(1);
  });

  it('retains original routing even if a shared session switches chats', async () => {
    queueMemoryChanges(db, receipt());
    upsertSessionRouting(db, { channel_type: 'telegram', platform_id: 'fixture-group', thread_id: 'new-topic' });
    await deliverMemoryChanges(db);
    expect(rows()[0].platform).toBe('fixture-dm');
  });

  it('drains metadata-only changes without queuing an empty receipt or retrying forever', async () => {
    const snapshot = details();
    snapshot.files[0].before = '# Notes\n<!-- akno:item mem_invented v=2 -->\n- Keep this note.\n';
    snapshot.files[0].after = '# Notes\n<!-- akno:item mem_invented v=3 -->\n- Keep this note.\n';
    service.command.mockResolvedValueOnce(snapshot);
    queueMemoryChanges(db, receipt());
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([]);
    expect(hasPendingMemoryChanges(db)).toBe(false);
    await deliverMemoryChanges(db);
    expect(service.command).toHaveBeenCalledTimes(1);
  });

  it('does not lose a newly queued change while reading an older snapshot', async () => {
    queueMemoryChanges(db, receipt('chg_old'));
    service.command.mockImplementationOnce(async () => {
      queueMemoryChanges(db, receipt('chg_new'));
      return details('chg_old');
    });
    await deliverMemoryChanges(db);
    expect(hasPendingMemoryChanges(db)).toBe(true);
    await deliverMemoryChanges(db);
    expect(rows()).toHaveLength(2);
  });

  it('keeps a missing service receipt queued and recovers on the next pass', async () => {
    queueMemoryChanges(db, receipt());
    service.command.mockRejectedValueOnce(new Error('socket unavailable'));
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([]);
    expect(hasPendingMemoryChanges(db)).toBe(true);
    await deliverMemoryChanges(db);
    expect(rows()).toHaveLength(1);
  });

  it('rejects mismatched snapshots and does not fabricate a diff for an expired change', async () => {
    queueMemoryChanges(db, receipt());
    service.command.mockResolvedValueOnce(details('chg_wrong'));
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([]);
    expect(hasPendingMemoryChanges(db)).toBe(true);
    service.command.mockRejectedValueOnce(new AknoError('not_found', 'expired'));
    await deliverMemoryChanges(db);
    expect(rows()[0].text).toContain('no longer available');
    expect(hasPendingMemoryChanges(db)).toBe(false);
  });

  it('respects notification settings and does not queue held or no-op writes', async () => {
    for (const outcome of ['noop', 'held', 'conflict', 'requires_approval', 'requires_folder']) {
      expect(queueMemoryChanges(db, { ...receipt(), outcome })).toBe(false);
    }
    service.notify = 'off';
    expect(queueMemoryChanges(db, receipt())).toBe(false);
    service.notify = 'pages';
    queueMemoryChanges(db, receipt());
    service.notify = 'off';
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([]);
    expect(hasPendingMemoryChanges(db)).toBe(false);
  });

  it('handles older services explicitly and suppresses internal mirrors', async () => {
    service.features = [];
    queueMemoryChanges(db, receipt());
    await deliverMemoryChanges(db);
    expect(rows()[0].text).toContain('diff is unavailable');
    expect(rows()[0].text).toContain('` notes/preferences `');
    expect(rows()[0].text).not.toContain('Created');
    queueMemoryChanges(db, { ...receipt('chg_mirror'), wrote: [{ slug: 'conversations/session/topic' }] });
    await deliverMemoryChanges(db);
    expect(rows()).toHaveLength(1);
    expect(service.command).not.toHaveBeenCalled();
  });

  it('preserves apply order for mixed remember receipts and retained candidates', async () => {
    queueMemoryChanges(db, {
      change_ids: ['chg_first', 'chg_last'],
      change_id: 'chg_last',
      candidates: [{ outcome: 'written', slug: 'notes/preferences' }],
    });
    await deliverMemoryChanges(db);
    expect(rows().map((row) => row.memoryChangeId)).toEqual(['chg_first', 'chg_last']);
  });

  it('suppresses receipts already undone before delivery', async () => {
    queueMemoryChanges(db, receipt());
    service.command.mockResolvedValueOnce({ ...details(), status: 'undone' });
    await deliverMemoryChanges(db);
    expect(rows()).toEqual([]);
    expect(getSessionState(db, 'memory:change-notifications')).toBe('[]');
  });

  it('bounds the compatibility notice even when a write affected many long page names', async () => {
    service.features = [];
    queueMemoryChanges(db, {
      ...receipt(),
      wrote: Array.from({ length: 50 }, (_, index) => ({ slug: `notes/${index}/${'🌙*'.repeat(500)}` })),
    });
    await deliverMemoryChanges(db);
    expect(rows()[0].text.length).toBeLessThan(3200);
    expect(rows()[0].text).toContain('47 more pages');
  });
});
