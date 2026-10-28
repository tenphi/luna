/**
 * Integration tests for the host core.
 * Tests routing, session creation, message writing, and delivery
 * without spawning actual containers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  getDb,
  initializeCentralSchema,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import {
  resolveSession,
  writeSessionMessage,
  writeSessionRouting,
  initSessionFolder,
  sessionDir,
  sessionDbPath,
  readOutboxFiles,
  clearOutbox,
} from './session-manager.js';
import { getSession, findSession } from './db/sessions.js';
import type { InboundEvent } from './channels/adapter.js';
vi.mock('./voice/inbound.js', () => ({ transcribeInboundContent: vi.fn(async (content: string) => content) }));

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', async () => {
  const { fakeContainers } = await import('../test/support/containers.js');
  return fakeContainers();
});

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-host' };
});

function now() {
  return new Date().toISOString();
}

const TEST_DIR = '/tmp/luna-test-host';

beforeEach(() => {
  // Clean test directory
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  initializeCentralSchema(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('session manager', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      created_at: now(),
    });
  });

  it('should create session folder and the single session.db', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'outbox'))).toBe(true);

    const dbPath = sessionDbPath('ag-1', 'sess-test');
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    db.close();

    // Both directions live in one file now.
    expect(tables).toContain('messages_in');
    expect(tables).toContain('delivered');
    expect(tables).toContain('messages_out');
    expect(tables).toContain('session_state');
    // The processing_ack side-channel is gone (status lives on messages_in).
    expect(tables).not.toContain('processing_ack');
  });

  it('should reject outbound attachment filenames that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['../../../../../outside.txt'])).toBeUndefined();
  });

  it('should reject outbound attachment symlinks that escape the message outbox', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });

    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'outside secret');
    fs.symlinkSync('../../../../../outside.txt', path.join(msgOutbox, 'safe-name.txt'));

    expect(readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['safe-name.txt'])).toBeUndefined();
  });

  it('should not recursively delete outside the outbox for unsafe message ids', () => {
    initSessionFolder('ag-1', 'sess-test');
    const victimDir = path.join(TEST_DIR, 'victim-dir');
    fs.mkdirSync(victimDir, { recursive: true });
    fs.writeFileSync(path.join(victimDir, 'keep.txt'), 'do not delete');

    clearOutbox('ag-1', 'sess-test', '../../../../victim-dir');

    expect(fs.existsSync(path.join(victimDir, 'keep.txt'))).toBe(true);
  });

  it('should still read and clear normal basename outbox files', () => {
    initSessionFolder('ag-1', 'sess-test');
    const dir = sessionDir('ag-1', 'sess-test');
    const msgOutbox = path.join(dir, 'outbox', 'msg-1');
    fs.mkdirSync(msgOutbox, { recursive: true });
    fs.writeFileSync(path.join(msgOutbox, 'result.txt'), 'ok');

    const files = readOutboxFiles('ag-1', 'sess-test', 'msg-1', ['result.txt']);
    expect(files).toHaveLength(1);
    expect(files?.[0]?.filename).toBe('result.txt');
    expect(files?.[0]?.data.toString()).toBe('ok');

    clearOutbox('ag-1', 'sess-test', 'msg-1');
    expect(fs.existsSync(msgOutbox)).toBe(false);
  });

  it('should reject inbound attachment writes through a pre-placed symlinked inbox dir', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container has /workspace write access, so it can pre create
    // inbox/<msgId> as a symlink to escape.
    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    fs.mkdirSync(inboxRoot, { recursive: true });
    const evilTarget = path.join(TEST_DIR, 'evil-target');
    fs.mkdirSync(evilTarget, { recursive: true });
    fs.symlinkSync(evilTarget, path.join(inboxRoot, 'msg-evil'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-evil',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'evil',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.existsSync(path.join(evilTarget, 'photo.png'))).toBe(false);
  });

  it('stages two attachments with the same original name without dropping either', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionMessage('ag-1', session.id, {
      id: 'msg-pair',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'Compare these',
        attachments: [
          { name: 'bill.pdf', data: Buffer.from('first').toString('base64') },
          { name: 'bill.pdf', data: Buffer.from('second').toString('base64') },
        ],
      }),
    });
    const db = new Database(sessionDbPath('ag-1', session.id));
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-pair') as { content: string };
      const attachments = (JSON.parse(row.content) as { attachments: Array<{ name: string; localPath: string }> })
        .attachments;
      expect(attachments.map((file) => file.name)).toEqual(['bill.pdf', 'bill (2).pdf']);
      expect(
        attachments.map((file) => fs.readFileSync(path.join(sessionDir('ag-1', session.id), file.localPath), 'utf8')),
      ).toEqual(['first', 'second']);
    } finally {
      db.close();
    }
  });

  it('gives an unsafe original name a safe type-aware fallback', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionMessage('ag-1', session.id, {
      id: 'msg-unsafe-name',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        attachments: [
          { name: '../../outside.pdf', mimeType: 'application/pdf', data: Buffer.from('fixture').toString('base64') },
        ],
      }),
    });
    const db = new Database(sessionDbPath('ag-1', session.id));
    try {
      const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-unsafe-name') as {
        content: string;
      };
      const attachment = (JSON.parse(row.content) as { attachments: Array<{ name: string; localPath: string }> })
        .attachments[0]!;
      expect(attachment.name).toBe('attachment.pdf');
      expect(attachment.localPath).toBe('inbox/msg-unsafe-name/attachment.pdf');
    } finally {
      db.close();
    }
  });

  it('should refuse to follow a pre-existing symlink at the inbound attachment path', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // The container pre creates inbox/<msgId>/photo.png as a symlink to a
    // host file. Without the wx flag, writeFileSync would follow it.
    const inboxDir = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-sym');
    fs.mkdirSync(inboxDir, { recursive: true });
    const outside = path.join(TEST_DIR, 'outside.txt');
    fs.writeFileSync(outside, 'ORIGINAL');
    fs.symlinkSync(outside, path.join(inboxDir, 'photo.png'));

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-sym',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'sym',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    expect(fs.readFileSync(outside, 'utf-8')).toBe('ORIGINAL');
  });

  it('should reject inbound attachments when messageId is unsafe', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: '../../escape',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'msgid',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const inboxRoot = path.join(sessionDir('ag-1', session.id), 'inbox');
    if (fs.existsSync(inboxRoot)) {
      expect(fs.readdirSync(inboxRoot)).toEqual([]);
    }
  });

  it('should still save inbound attachments with safe basenames', () => {
    initSessionFolder('ag-1', 'sess-test');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    writeSessionMessage('ag-1', session.id, {
      id: 'msg-ok',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        text: 'ok',
        attachments: [{ name: 'photo.png', data: Buffer.from('PNGBYTES').toString('base64'), size: 8 }],
      }),
    });

    const expected = path.join(sessionDir('ag-1', session.id), 'inbox', 'msg-ok', 'photo.png');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe('PNGBYTES');
  });

  it.each([
    ['shared', null, null, true],
    ['per-thread', 'one', 'one', true],
    ['per-thread', 'one', 'two', false],
  ] as const)('resolves %s sessions according to their conversation identity', (mode, first, second, same) => {
    const initial = resolveSession('ag-1', 'mg-1', first, mode);
    const repeated = resolveSession('ag-1', 'mg-1', second, mode);
    expect(repeated.session.id === initial.session.id).toBe(same);
    expect(repeated.created).toBe(!same);
  });
  it('queues an inbound turn and updates activity without changing the submitted text', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    const content = JSON.stringify({ text: 'Synthetic calendar request', sender: 'Ada Marlow' });
    writeSessionMessage('ag-1', session.id, {
      id: 'fixture-turn',
      kind: 'chat',
      content,
      timestamp: now(),
      channelType: 'telegram',
      platformId: 'chan-123',
      threadId: null,
    });
    const handle = new Database(sessionDbPath('ag-1', session.id));
    try {
      expect(handle.prepare('SELECT id, content, status FROM messages_in').get()).toEqual({
        id: 'fixture-turn',
        content,
        status: 'pending',
      });
      expect(getSession(session.id)?.last_active).not.toBeNull();
    } finally {
      handle.close();
    }
  });
  it.each(['../escape.txt', '/absolute.txt', 'folder/nested.txt'])('stages bytes under a safe name for %s', (name) => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionMessage('ag-1', session.id, {
      id: 'unsafe-name-fixture',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({
        attachments: [{ type: 'document', name, data: Buffer.from('fixture bytes').toString('base64') }],
      }),
    });
    const folder = path.join(sessionDir('ag-1', session.id), 'inbox', 'unsafe-name-fixture');
    const files = fs.readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[/]|\.\./);
    expect(fs.readFileSync(path.join(folder, files[0]), 'utf8')).toBe('fixture bytes');
  });
});

describe('router', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      agent_provider: null,
      created_at: now(),
    });
    // Use 'public' policy so the router tests exercise routing, not the
    // access gate. Dedicated access-gate tests live with the access module.
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('auto-creates messaging group only when the bot is addressed (mention/DM)', async () => {
    const { routeInbound } = await import('./router.js');
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');

    // Plain message on unknown channel — should NOT auto-create.
    await routeInbound({
      channelType: 'cli',
      platformId: 'C-PLAIN',
      threadId: null,
      message: {
        id: 'msg-plain',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Hi' }),
        timestamp: now(),
      },
    });
    expect(getMessagingGroupByPlatform('cli', 'C-PLAIN')).toBeUndefined();

    // Mention on unknown channel — SHOULD auto-create (next step: channel-registration flow).
    await routeInbound({
      channelType: 'cli',
      platformId: 'C-MENTIONED',
      threadId: null,
      message: {
        id: 'msg-mentioned',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
      },
    });
    expect(getMessagingGroupByPlatform('cli', 'C-MENTIONED')).toBeDefined();
  });

  it('refuses audio before transcription or attachment staging when access is denied', async () => {
    const { routeInbound, setAccessGate } = await import('./router.js');
    const { transcribeInboundContent } = await import('./voice/inbound.js');
    vi.mocked(transcribeInboundContent).mockClear();
    setAccessGate(() => ({ allowed: false, reason: 'synthetic_unknown_sender' }));
    try {
      await routeInbound({
        channelType: 'telegram',
        platformId: 'chan-123',
        threadId: null,
        message: {
          id: 'untrusted-audio',
          kind: 'chat',
          timestamp: now(),
          isMention: true,
          content: JSON.stringify({ attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: 'c3ludGhldGlj' }] }),
        },
      });
      expect(transcribeInboundContent).not.toHaveBeenCalled();
      expect(findSession('mg-1', null)).toBeUndefined();
    } finally {
      setAccessGate(() => ({ allowed: true }));
    }
  });

  it('queues two turns in the same channel session and wakes after each', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();
    for (const id of ['first-fixture-turn', 'second-fixture-turn'])
      await routeInbound({
        channelType: 'telegram',
        platformId: 'chan-123',
        threadId: null,
        message: { id, kind: 'chat', content: JSON.stringify({ text: id }), timestamp: now() },
      });
    const session = findSession('mg-1', null)!;
    const database = new Database(sessionDbPath('ag-1', session.id));
    try {
      expect(database.prepare('SELECT COUNT(*) AS total FROM messages_in').get()).toEqual({ total: 2 });
    } finally {
      database.close();
    }
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['.', 1],
    ['\\bluna\\b', 0],
  ] as const)('routes an uncaptioned forwarded file under pattern %s', async (pattern, stored) => {
    // The reported shape: "save this" as one message, then the forwarded document with no caption.
    const { routeInbound } = await import('./router.js');
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    const { wakeContainer } = await import('./container-runner.js');
    updateMessagingGroupAgent('mga-1', { engage_pattern: pattern });
    vi.mocked(wakeContainer).mockClear();
    await routeInbound({
      channelType: 'telegram',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'uncaptioned-forward-fixture',
        kind: 'chat-sdk',
        timestamp: now(),
        isMention: true,
        content: JSON.stringify({
          text: '',
          attachments: [{ type: 'file', name: 'fixture-contract.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' }],
          forwardedFrom: { from: 'Bo Winters' },
        }),
      },
    });
    const session = findSession('mg-1', null);
    const rows = session
      ? (() => {
          const database = new Database(sessionDbPath('ag-1', session.id));
          try {
            return (database.prepare('SELECT COUNT(*) AS total FROM messages_in').get() as { total: number }).total;
          } finally {
            database.close();
          }
        })()
      : 0;
    expect(rows).toBe(stored);
    expect(wakeContainer).toHaveBeenCalledTimes(stored);
  });

  it('fans out a turn into separate per-agent queues', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    const { getMessagingGroupAgents } = await import('./db/messaging-groups.js');
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const existing = getMessagingGroupAgents('mg-1')[0];
    createAgentGroup({ name: 'Secondary fixture agent', id: 'ag-second', created_at: now(), agent_provider: null });
    createMessagingGroupAgent({ ...existing, id: 'additional-fixture-wiring', agent_group_id: 'ag-second' });
    vi.mocked(wakeContainer).mockClear();
    await routeInbound({
      channelType: 'telegram',
      platformId: 'chan-123',
      threadId: null,
      message: { id: 'fanout-fixture', kind: 'chat', timestamp: now(), content: '{"text":"Shared synthetic request"}' },
    });
    const sessions = ['ag-1', 'ag-second'].map((id) => getSessionsByAgentGroup(id));
    expect(sessions.map((rows) => rows.length)).toEqual([1, 1]);
    expect(sessions[0][0].id).not.toBe(sessions[1][0].id);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['accumulate', true, true],
    ['drop', true, false],
    ['accumulate', false, false],
  ] as const)('handles silent context with policy=%s and access=%s', async (policy, allowed, stored) => {
    const { routeInbound, setAccessGate } = await import('./router.js');
    const { updateMessagingGroupAgent } = await import('./db/messaging-groups.js');
    const { wakeContainer } = await import('./container-runner.js');
    updateMessagingGroupAgent('mga-1', { engage_mode: 'mention', ignored_message_policy: policy });
    setAccessGate(() => (allowed ? { allowed: true } : { allowed: false, reason: 'synthetic_denial' }));
    vi.mocked(wakeContainer).mockClear();
    try {
      await routeInbound({
        channelType: 'telegram',
        platformId: 'chan-123',
        threadId: null,
        message: {
          id: 'quiet-context-fixture',
          kind: 'chat',
          timestamp: now(),
          isMention: false,
          content: '{"text":"Unaddressed fixture"}',
        },
      });
      expect(wakeContainer).not.toHaveBeenCalled();
      const session = findSession('mg-1', null);
      expect(Boolean(session)).toBe(stored);
      if (session) {
        const database = new Database(sessionDbPath('ag-1', session.id));
        try {
          expect(database.prepare('SELECT trigger FROM messages_in').get()).toEqual({ trigger: 0 });
        } finally {
          database.close();
        }
      }
    } finally {
      setAccessGate(() => ({ allowed: true }));
    }
  });

  it('ephemeral CLI events create a new session on each message', async () => {
    createMessagingGroup({
      id: 'mg-cli',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'CLI',
      is_group: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-cli',
      messaging_group_id: 'mg-cli',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const { routeInbound } = await import('./router.js');
    const mkEvent = (id: string): InboundEvent => ({
      channelType: 'cli',
      platformId: 'local',
      threadId: null,
      ephemeral: true,
      message: {
        id,
        kind: 'chat',
        content: JSON.stringify({ sender: 'cli', text: 'hi' }),
        timestamp: now(),
      },
    });

    await routeInbound(mkEvent('cli-1'));
    await routeInbound(mkEvent('cli-2'));

    const sessions = getDb().prepare('SELECT id FROM sessions WHERE messaging_group_id = ?').all('mg-cli') as Array<{
      id: string;
    }>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).not.toBe(sessions[1].id);
  });
});

describe('routing metadata preservation', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  it('routed message carries platformId, channelType, threadId on the messages_in row', async () => {
    const { routeInbound } = await import('./router.js');

    await routeInbound({
      channelType: 'telegram',
      platformId: 'chan-123',
      threadId: 'thread-42',
      message: { id: 'msg-r1', kind: 'chat', content: JSON.stringify({ sender: 'A', text: 'hi' }), timestamp: now() },
    });

    const session = findSession('mg-1', null);
    const db = new Database(sessionDbPath('ag-1', session!.id));
    const row = db
      .prepare('SELECT platform_id, channel_type, thread_id FROM messages_in WHERE id LIKE ?')
      .get('msg-r1%') as {
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
    };
    db.close();

    expect(row.platform_id).toBe('chan-123');
    expect(row.channel_type).toBe('telegram');
    expect(row.thread_id).toBe('thread-42');
  });

  it('fan-out gives each agent its own routing, not leaked from sibling', async () => {
    const { routeInbound } = await import('./router.js');

    createAgentGroup({
      id: 'ag-2',
      name: 'Agent Two',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-2',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await routeInbound({
      channelType: 'telegram',
      platformId: 'chan-123',
      threadId: 'thread-fanout',
      message: { id: 'msg-fo', kind: 'chat', content: JSON.stringify({ text: 'fan' }), timestamp: now() },
    });

    // Both agents should have the message with correct routing
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    for (const agId of ['ag-1', 'ag-2']) {
      const sessions = getSessionsByAgentGroup(agId);
      expect(sessions).toHaveLength(1);
      const db = new Database(sessionDbPath(agId, sessions[0].id));
      const row = db.prepare('SELECT platform_id, channel_type, thread_id FROM messages_in LIMIT 1').get() as {
        platform_id: string | null;
        channel_type: string | null;
        thread_id: string | null;
      };
      db.close();
      expect(row.platform_id).toBe('chan-123');
      expect(row.channel_type).toBe('telegram');
      expect(row.thread_id).toBe('thread-fanout');
    }
  });
});

describe('writeSessionRouting', () => {
  it('populates session_routing from the messaging group', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'tg:12345',
      name: 'Chat',
      is_group: 0,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(sessionDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('telegram');
    expect(row!.platform_id).toBe('tg:12345');
    expect(row!.thread_id).toBeNull();
  });

  it('writes null routing for agent-shared session (no messaging group)', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(sessionDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBeNull();
    expect(row!.platform_id).toBeNull();
    expect(row!.thread_id).toBeNull();
  });

  it('includes thread_id from per-thread session', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-1', 'thread-77', 'per-thread');
    writeSessionRouting('ag-1', session.id);

    const db = new Database(sessionDbPath('ag-1', session.id));
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
          thread_id: string | null;
        }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('telegram');
    expect(row!.platform_id).toBe('chan-123');
    expect(row!.thread_id).toBe('thread-77');
  });
});

describe('agent-shared session resolution', () => {
  it('resolves to the same session on repeated calls', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session: s1, created: c1 } = resolveSession('ag-1', null, null, 'agent-shared');
    const { session: s2, created: c2 } = resolveSession('ag-1', null, null, 'agent-shared');

    expect(c1).toBe(true);
    expect(c2).toBe(false);
    expect(s1.id).toBe(s2.id);
  });

  it('agent-shared session has null messaging_group_id', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', null, null, 'agent-shared');
    expect(session.messaging_group_id).toBeNull();
  });
});

describe('agent-to-agent routing', () => {
  beforeEach(() => {
    createAgentGroup({
      id: 'ag-pa',
      name: 'PA',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-cli',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'CLI',
      is_group: 0,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-researcher',
      name: 'Researcher',
      agent_provider: null,
      created_at: now(),
    });

    // Wire bidirectional A2A destinations (table created by initializeCentralSchema)
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-pa', 'researcher', 'agent', 'ag-researcher', ?)`,
    ).run(now());
    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-researcher', 'pa', 'agent', 'ag-pa', ?)`,
    ).run(now());
  });

  it('A2A outbound lands in a session for the target agent', async () => {
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paCliSession } = resolveSession('ag-pa', 'mg-cli', null, 'shared');

    await routeAgentMessage(
      {
        id: 'out-a2a-1',
        platform_id: 'ag-researcher',
        content: JSON.stringify({ text: 'research this' }),
        in_reply_to: null,
      },
      paCliSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions.length).toBeGreaterThanOrEqual(1);

    const rDb = new Database(sessionDbPath('ag-researcher', researcherSessions[0].id));
    const rows = rDb.prepare('SELECT platform_id, channel_type, content FROM messages_in').all() as Array<{
      platform_id: string | null;
      channel_type: string | null;
      content: string;
    }>;
    rDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('agent');
    expect(rows[0].platform_id).toBe('ag-pa');
    expect(JSON.parse(rows[0].content).text).toBe('research this');
  });

  it('A2A return path routes to originating session, not newest (#2332)', async () => {
    // PA has CLI session, then gets wired to Telegram (newer session).
    // Researcher responds to PA. With the return-path fix, the reply
    // routes back to the CLI session (originator) not Telegram (newest).
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paCliSession } = resolveSession('ag-pa', 'mg-cli', null, 'shared');

    createMessagingGroup({
      id: 'mg-telegram',
      channel_type: 'telegram',
      platform_id: 'chan-telegram',
      name: 'Telegram',
      is_group: 0,
      created_at: now(),
    });
    const { session: paTelegramSession } = resolveSession('ag-pa', 'mg-telegram', null, 'shared');

    // PA sends from CLI
    await routeAgentMessage(
      { id: 'out-fwd', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'research' }), in_reply_to: null },
      paCliSession,
    );

    // Researcher responds back to PA
    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSession = getSessionsByAgentGroup('ag-researcher')[0];

    await routeAgentMessage(
      { id: 'out-reply', platform_id: 'ag-pa', content: JSON.stringify({ text: 'found it' }), in_reply_to: null },
      researcherSession,
    );

    const cliDb = new Database(sessionDbPath('ag-pa', paCliSession.id));
    const cliA2a = cliDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    cliDb.close();

    const telegramDb = new Database(sessionDbPath('ag-pa', paTelegramSession.id));
    const telegramA2a = telegramDb.prepare("SELECT * FROM messages_in WHERE channel_type = 'agent'").all();
    telegramDb.close();

    // Fixed: response lands in CLI (origin) not Telegram (newest)
    expect(cliA2a).toHaveLength(1);
    expect(telegramA2a).toHaveLength(0);
  });

  it('BUG: A2A-only session gets null session_routing (#2332)', async () => {
    // Researcher only has an agent-shared session (no channel wiring).
    // writeSessionRouting writes nulls because messaging_group_id is null.
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');

    const { session: paSession } = resolveSession('ag-pa', 'mg-cli', null, 'shared');
    await routeAgentMessage(
      { id: 'out-1', platform_id: 'ag-researcher', content: JSON.stringify({ text: 'go' }), in_reply_to: null },
      paSession,
    );

    const { getSessionsByAgentGroup } = await import('./db/sessions.js');
    const researcherSessions = getSessionsByAgentGroup('ag-researcher');
    expect(researcherSessions).toHaveLength(1);

    writeSessionRouting('ag-researcher', researcherSessions[0].id);

    const rDb = new Database(sessionDbPath('ag-researcher', researcherSessions[0].id));
    const routing = rDb.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as
      | {
          channel_type: string | null;
          platform_id: string | null;
        }
      | undefined;
    rDb.close();

    // BUG: session_routing is all null — researcher has no default routing
    expect(routing).toBeDefined();
    expect(routing!.channel_type).toBeNull();
    expect(routing!.platform_id).toBeNull();
  });
});

describe('delivery', () => {
  it('should detect undelivered messages in outbound DB', () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-test',
      channel_type: 'telegram',
      platform_id: 'chan-test',
      name: 'Test',
      is_group: 0,
      created_at: now(),
    });

    const { session } = resolveSession('ag-1', 'mg-test', null, 'shared');

    // Write a response to the outbound DB (simulating what the agent-runner does)
    const dbPath = sessionDbPath('ag-1', session.id);
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-1', datetime('now'), 'chat', 'chan-123', 'telegram', ?)`,
    ).run(JSON.stringify({ text: 'Agent response' }));

    const undelivered = db.prepare('SELECT * FROM messages_out').all() as Array<{
      id: string;
      content: string;
    }>;
    db.close();

    expect(undelivered).toHaveLength(1);
    expect(JSON.parse(undelivered[0].content).text).toBe('Agent response');
  });
});
