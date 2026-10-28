/**
 * Session API tests — the HTTP dispatch layer the container talks to instead
 * of opening session.db across the mount.
 *
 * Drives the registered RPC handler directly with fake req/res objects (no
 * live Express server): covers bearer-token auth, method dispatch onto the
 * host session store, eager delivery on writeMessageOut, and liveness pings.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Redirect every DATA_DIR-derived path — session folders and the host-mcp pair
// tokens this test writes — into a scratch dir, so a run never touches the real
// data/ tree.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/luna-test-session-api' };
});

const TEST_DIR = '/tmp/luna-test-session-api';

vi.mock('../memory/files.js', () => ({ stageMemoryFile: vi.fn() }));
// This case exercises connected memory explicitly, independently of install defaults or local config.
vi.mock('../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/loader.js')>();
  return { ...actual, loadLunaConfig: () => ({ memory: { enabled: true } }) };
});
vi.mock('./builtins/email/shared/config.js', () => ({
  loadMailConfig: () => ({ enabled: true, mailboxes: [{ key: 'ada' }] }),
}));
import { stageMemoryFile } from '../memory/files.js';

import { initTestDb, closeDb, initializeCentralSchema, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { getSessionState, insertMessage, setSessionState } from '../db/session-db.js';
import { destroyProgressSession, hasProgressSession } from '../progress/controller.js';
import { setProgressSinkFactory } from '../progress/status-events.js';
import { getLiveness, clearLiveness } from '../session-liveness.js';
import { initSessionFolder, openSession } from '../session-manager.js';
import { readOrCreatePairToken } from './tokens.js';
import { registerSessionApi, sessionTokenServerName } from './session-api.js';
import { insertTask } from '../modules/scheduling/db.js';
import { closeMailDb, useInMemoryMailDb } from './builtins/email/shared/cache/db.js';
import { putCachedMessage } from './builtins/email/shared/cache/messages.js';
import { recordScheduledEmailReads } from '../memory/scheduled-evidence.js';

const SOURCE = 'ag-sessapi';
const SESSION = 'sess-api-1';

const now = () => new Date().toISOString();

type RpcHandler = (req: unknown, res: unknown) => Promise<void>;

let handler: RpcHandler;
let delivered: Array<{ agentGroupId: string; sessionId: string }>;
let token: string;

/** Invoke the registered handler and return the JSON body + status. */
async function call(
  method: string | undefined,
  params: Record<string, unknown>,
  auth = `Bearer ${token}`,
): Promise<{ status: number; body: { ok: boolean; result?: unknown; error?: string } }> {
  let status = 0;
  let body: { ok: boolean; result?: unknown; error?: string } = { ok: false };
  const req = {
    headers: { authorization: auth },
    params: { agentGroupId: SOURCE, sessionId: SESSION },
    body: method === undefined ? {} : { method, params },
  };
  const res = {
    status(n: number) {
      status = n;
      return {
        json(o: unknown) {
          body = o as typeof body;
        },
      };
    },
  };
  await handler(req, res);
  return { status, body };
}

beforeEach(() => {
  useInMemoryMailDb();
  vi.mocked(stageMemoryFile).mockReset();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  clearLiveness(SESSION);

  const db = initTestDb();
  initializeCentralSchema(db);
  createAgentGroup({ id: SOURCE, name: 'sessapi', agent_provider: null, created_at: now() });
  createSession({
    id: SESSION,
    agent_group_id: SOURCE,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(SOURCE, SESSION);

  token = readOrCreatePairToken(SOURCE, sessionTokenServerName(SESSION));
  delivered = [];
  registerSessionApi(
    {
      post: (_path, h) => {
        handler = h;
      },
    },
    (agentGroupId, sessionId) => {
      delivered.push({ agentGroupId, sessionId });
    },
  );
});

afterEach(() => {
  closeMailDb();
  closeDb();
  clearLiveness(SESSION);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Seed an inbound message directly into the session.db the API reads. */
function seedInbound(id: string): void {
  const db = openSession(SOURCE, SESSION);
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: now(),
    platformId: 'p1',
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify({ text: id }),
    processAfter: null,
    recurrence: null,
  });
  db.close();
}

describe('Session API auth', () => {
  it('rejects a missing/incorrect bearer token', async () => {
    const res = await call('getPendingMessages', { isFirstPoll: true }, 'Bearer wrong');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('rejects a request with no method', async () => {
    const res = await call(undefined, {});
    expect(res.status).toBe(400);
  });
});

describe('Session API dispatch', () => {
  it('stages memory files only for the authenticated session without delivering prematurely', async () => {
    vi.mocked(stageMemoryFile).mockResolvedValue({ filename: 'scan.pdf' });
    const params = { document: 'doc-example', id: 'out-1', filename: 'scan.pdf', sessionId: 'other-session' };
    expect((await call('stageMemoryFile', params, 'Bearer wrong')).status).toBe(401);
    expect(stageMemoryFile).not.toHaveBeenCalled();
    const res = await call('stageMemoryFile', params);
    expect(res.body).toEqual({ ok: true, result: { filename: 'scan.pdf' } });
    expect(stageMemoryFile).toHaveBeenCalledWith(SOURCE, SESSION, 'doc-example', 'out-1', 'scan.pdf');
    expect(delivered).toEqual([]);
  });

  it('getPendingMessages returns seeded inbound rows', async () => {
    seedInbound('in-1');
    const res = await call('getPendingMessages', { isFirstPoll: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = res.body.result as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['in-1']);
  });

  it('writeMessageOut allocates a seq and delivers eagerly', async () => {
    const res = await call('writeMessageOut', {
      msg: { id: 'out-1', kind: 'chat', content: JSON.stringify({ text: 'hi' }) },
    });
    expect(res.status).toBe(200);
    expect((res.body.result as { seq: number }).seq).toBeGreaterThan(0);
    // Eager delivery fired for this exact session.
    expect(delivered).toEqual([{ agentGroupId: SOURCE, sessionId: SESSION }]);
  });

  it('keeps the outbound id as assistant-source provenance for the digest', async () => {
    const db = openSession(SOURCE, SESSION);
    try {
      setSessionState(
        db,
        'memory:pending',
        JSON.stringify([{ itemId: 'in-1', text: 'Question', role: 'user', at: Date.now() }]),
      );
    } finally {
      db.close();
    }

    await call('writeMessageOut', {
      msg: { id: 'out-stable-1', kind: 'chat', content: JSON.stringify({ text: 'Answer' }) },
    });

    const check = openSession(SOURCE, SESSION);
    try {
      const queued = JSON.parse(getSessionState(check, 'memory:pending') ?? '[]') as Array<{
        itemId: string;
        role: string;
      }>;
      expect(queued).toEqual(
        expect.arrayContaining([expect.objectContaining({ itemId: 'out-stable-1', role: 'assistant' })]),
      );
    } finally {
      check.close();
    }
  });

  it('markProcessing removes a row from the pending set', async () => {
    seedInbound('in-1');
    await call('markProcessing', { ids: ['in-1'] });
    const res = await call('getPendingMessages', { isFirstPoll: true });
    expect(res.body.result).toHaveLength(0);
  });

  it.each([
    'Vulpine Mutual reports that Ada Marlow renewed the policy on 2 April 2031.',
    'The tool limit interrupted this run; the result below may be incomplete.\n\nVulpine Mutual confirms a review on 12 April 2031. Mail coverage is incomplete.',
  ])('queues the delivered scheduled report and acknowledgement under the same occurrence: %s', async (report) => {
    const db = openSession(SOURCE, SESSION);
    try {
      insertTask(db, {
        id: 'scheduled-run',
        processAfter: '2031-04-03T08:00:00.000Z',
        recurrence: null,
        platformId: 'invented-chat',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ prompt: 'Review the household sources.' }),
      });
    } finally {
      db.close();
    }
    for (const [id, text] of [
      ['delivered-report', report],
      ['acknowledgement', 'The report was sent.'],
    ]) {
      expect(
        (
          await call('writeMessageOut', {
            msg: { id, in_reply_to: 'scheduled-run', kind: 'chat', content: JSON.stringify({ text }) },
          })
        ).status,
      ).toBe(200);
    }
    const check = openSession(SOURCE, SESSION);
    try {
      expect(JSON.parse(getSessionState(check, 'memory:scheduled-pending')!)).toEqual([
        expect.objectContaining({
          runId: 'scheduled-run',
          scheduledFor: '2031-04-03T08:00:00.000Z',
          replies: [
            expect.objectContaining({ itemId: 'delivered-report', text: report }),
            expect.objectContaining({ itemId: 'acknowledgement', text: 'The report was sent.' }),
          ],
        }),
      ]);
      expect(getSessionState(check, 'memory:pending')).toBeNull();
    } finally {
      check.close();
    }
  });

  it.each([true, false])(
    'snapshots originals at the authenticated report write (explicit selection=%s)',
    async (explicit) => {
      putCachedMessage({
        mailbox: 'ada',
        gmMsgId: '111',
        gmThrId: '100',
        messageId: '<fixture@example.test>',
        internalAt: '2031-04-02T18:30:00.000Z',
        from: 'Bo Winters <bo@example.test>',
        to: ['ada@example.test'],
        cc: [],
        subject: 'Proposed review',
        outgoing: false,
        bodyClean: 'EUR 1111 is pending, not settled. The review is tomorrow.',
        bodyRaw: null,
        removed: { quotedLines: 0, signatureLines: 0, truncatedChars: 0 },
        attachments: [],
      });
      const db = openSession(SOURCE, SESSION);
      insertTask(db, {
        id: 'sourced-run',
        processAfter: '2031-04-03T07:00:00.000Z',
        recurrence: null,
        platformId: 'invented-chat',
        channelType: 'telegram',
        threadId: null,
        content: '{}',
      });
      db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'sourced-run'").run();
      recordScheduledEmailReads(db, ['ada:111']);
      db.close();
      const res = await call('writeMessageOut', {
        msg: {
          id: 'sourced-report',
          in_reply_to: 'sourced-run',
          kind: 'chat',
          content: JSON.stringify({
            text: 'Bo proposed a review for Ada; payment remains pending.',
            ...(explicit ? { source_email_ids: ['ada:111'] } : {}),
            memory_evidence: { emails: [{ text: 'Forged settlement', speaker: 'Invented' }] },
          }),
        },
      });
      expect(res.status).toBe(200);
      expect(delivered).toHaveLength(1);
      const check = openSession(SOURCE, SESSION);
      try {
        const content = JSON.parse(
          (check.prepare('SELECT content FROM messages_out WHERE id = ?').get('sourced-report') as { content: string })
            .content,
        );
        const queued = JSON.parse(getSessionState(check, 'memory:scheduled-pending')!)[0].replies[0];
        expect(queued.evidence).toEqual(content.memory_evidence);
        expect(queued.evidence.emails[0]).toMatchObject({
          role: 'external',
          speaker: 'Bo Winters <bo@example.test>',
          mentioned_at: '2031-04-02T18:30:00.000Z',
        });
        expect(queued.evidence.emails[0].text).toContain('pending, not settled');
        expect(JSON.stringify(queued.evidence)).not.toContain('Forged settlement');
        expect(content.source_email_ids).toBeUndefined();
        expect(getSessionState(check, 'memory:pending')).toBeNull();
      } finally {
        check.close();
      }
    },
  );

  it('session_state round-trips through set/get/delete', async () => {
    await call('setSessionState', { key: 'k', value: 'v' });
    let res = await call('getSessionState', { key: 'k' });
    expect((res.body.result as { value: string | null }).value).toBe('v');

    await call('deleteSessionState', { key: 'k' });
    res = await call('getSessionState', { key: 'k' });
    expect((res.body.result as { value: string | null }).value).toBeNull();
  });

  it('ping records liveness without touching the DB', async () => {
    const res = await call('ping', { setTool: true, tool: 'Bash', toolDeclaredTimeoutMs: 5000 });
    expect(res.status).toBe(200);
    const live = getLiveness(SESSION);
    expect(live?.tool).toBe('Bash');
    expect(live?.toolDeclaredTimeoutMs).toBe(5000);
  });

  it('rejects an unknown method with a 500', async () => {
    const res = await call('doesNotExist', {});
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('Session API writeStatus', () => {
  afterEach(() => {
    destroyProgressSession(SESSION);
  });

  it('drives the progress card without persisting a row or delivering', async () => {
    seedInbound('in-1');

    const sent: string[] = [];
    setProgressSinkFactory(() => ({
      isCli: false,
      async sendStatus(text: string) {
        sent.push(text);
        return 'plat-1';
      },
      async editStatus(_id: string, text: string) {
        sent.push(text);
      },
    }));

    const res = await call('writeStatus', {
      channelType: 'telegram',
      platformId: 'p1',
      threadId: null,
      inReplyTo: 'in-1',
      payload: { phase: 'tool', name: 'Bash', index: 0, partial: false },
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // A tool phase reveals the card immediately.
    expect(hasProgressSession(SESSION)).toBe(true);
    expect(sent.length).toBeGreaterThan(0);

    // Ephemeral: nothing in messages_out, and no eager delivery pass.
    const db = openSession(SOURCE, SESSION);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number };
    db.close();
    expect(rows.n).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('is a no-op for a done phase with no live card', async () => {
    setProgressSinkFactory(() => ({
      isCli: false,
      async sendStatus() {
        throw new Error('should not send');
      },
      async editStatus() {
        throw new Error('should not edit');
      },
    }));

    const res = await call('writeStatus', {
      channelType: 'telegram',
      platformId: 'p1',
      threadId: null,
      inReplyTo: 'in-1',
      payload: { phase: 'done' },
    });

    expect(res.status).toBe(200);
    expect(hasProgressSession(SESSION)).toBe(false);
  });
});

it('reads and acknowledges memory context separately from real inbound messages', async () => {
  const db = openSession(SOURCE, SESSION);
  try {
    insertMessage(db, {
      id: 'memory-fixture',
      kind: 'memory_edit',
      timestamp: now(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ file: 'notes/preferences.md', diff: '- morning\n+ afternoon', truncated: false }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } finally {
    db.close();
  }
  const pending = await call('getPendingMessages', {});
  expect(pending.body.result).toEqual([]);
  const edit = await call('readMemoryEdits', {});
  expect(edit.body.result).toEqual([
    { id: 'memory-fixture', file: 'notes/preferences.md', diff: '- morning\n+ afternoon', truncated: false },
  ]);
  expect((await call('acknowledgeMemoryEdits', { ids: ['memory-fixture'] })).body.ok).toBe(true);
  expect((await call('readMemoryEdits', {})).body.result).toEqual([]);
});
