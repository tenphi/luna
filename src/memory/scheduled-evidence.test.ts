import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../host-mcp/builtins/email/shared/config.js', () => ({
  loadMailConfig: () => ({ enabled: true, mailboxes: [{ key: 'ada' }] }),
}));

import { insertOutboundMessage, setSessionState } from '../db/session-db.js';
import { SESSION_SCHEMA } from '../db/schema.js';
import { insertTask } from '../modules/scheduling/db.js';
import { closeMailDb, useInMemoryMailDb } from '../host-mcp/builtins/email/shared/cache/db.js';
import { putCachedMessage, type CachedMessage } from '../host-mcp/builtins/email/shared/cache/messages.js';
import { prepareScheduledReport, recordScheduledEmailReads } from './scheduled-evidence.js';

let db: Database.Database;
function email(overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    mailbox: 'ada',
    gmMsgId: '111',
    gmThrId: '100',
    messageId: '<notice@example.test>',
    internalAt: '2031-04-02T20:30:00+02:00',
    from: 'Bo Winters <bo@example.test>',
    to: ['ada@example.test'],
    cc: [],
    subject: 'Proposed review',
    outgoing: false,
    bodyClean: 'The proposed review is tomorrow. EUR 1111 is pending, not settled. No booking is confirmed.',
    bodyRaw: null,
    removed: { quotedLines: 0, signatureLines: 0, truncatedChars: 0 },
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  useInMemoryMailDb();
  db = new Database(':memory:');
  db.exec(SESSION_SCHEMA);
  insertTask(db, {
    id: 'run-a',
    processAfter: '2031-04-03T07:00:00.000Z',
    recurrence: null,
    platformId: 'invented-chat',
    channelType: 'telegram',
    threadId: null,
    content: '{}',
  });
  putCachedMessage(email());
});
afterEach(() => {
  db.close();
  closeMailDb();
});

function prepare(ids: unknown = ['ada:111'], extra: Record<string, unknown> = {}) {
  return prepareScheduledReport(db, {
    id: 'report-a',
    kind: 'chat',
    in_reply_to: 'run-a',
    content: JSON.stringify({
      text: 'Bo proposed a review for Ada; payment and booking remain unconfirmed.',
      source_email_ids: ids,
      ...extra,
    }),
  });
}

describe('scheduled email evidence snapshot', () => {
  it('links exact visible findings to canonical selected original identities', () => {
    const text = 'Bo proposed a review for Ada; payment and booking remain unconfirmed.';
    const content = JSON.parse(
      prepare(['ada:111'], { source_email_findings: [{ text, source_email_ids: ['ada:111'] }] }).content,
    );
    expect(content.source_email_findings).toBeUndefined();
    expect(content.memory_evidence.findings).toEqual([{ text, item_ids: ['email:ada:111'] }]);
  });

  it('rejects invented report excerpts, foreign source references and hidden internal text', () => {
    expect(() =>
      prepare(['ada:111', 'ada:222'], {
        source_email_findings: [{ text: 'Bo proposed', source_email_ids: ['ada:111'] }],
      }),
    ).toThrow();
    expect(() =>
      prepare(['ada:111'], { source_email_findings: [{ text: 'Payment settled.', source_email_ids: ['ada:111'] }] }),
    ).toThrow();
    expect(() =>
      prepare(['ada:111'], { source_email_findings: [{ text: 'Bo proposed', source_email_ids: ['ada:222'] }] }),
    ).toThrow();
    expect(() =>
      prepare(['ada:111'], {
        text: 'Visible.<internal>Hidden proposal.</internal>',
        source_email_findings: [{ text: 'Hidden proposal.', source_email_ids: ['ada:111'] }],
      }),
    ).toThrow();
  });

  it('preserves literal Markdown findings and refuses their rendered paraphrases', () => {
    const finding = '**Bo — Ada:** Payment **EUR 25** remains pending; *no booking is confirmed*.';
    const text = `## Daily digest\n\n- ${finding}`;
    expect(() =>
      prepare(['ada:111'], {
        text,
        source_email_findings: [{ text: finding.replace(/\*/g, ''), source_email_ids: ['ada:111'] }],
      }),
    ).toThrow('Each email finding must quote visible report text');
    const content = JSON.parse(
      prepare(['ada:111'], {
        text,
        source_email_findings: [{ text: finding, source_email_ids: ['ada:111'] }],
      }).content,
    );
    expect(content.text).toBe(text);
    expect(content.memory_evidence.findings).toEqual([{ text: finding, item_ids: ['email:ada:111'] }]);
    expect(content.source_email_findings).toBeUndefined();
  });

  it('uses cached original attribution and time, retaining the complete qualifications', () => {
    const content = JSON.parse(prepare().content);
    expect(content.source_email_ids).toBeUndefined();
    expect(content.memory_evidence).toEqual({
      emails: [
        expect.objectContaining({
          item_id: 'email:ada:111',
          role: 'external',
          speaker: 'Bo Winters <bo@example.test>',
          mentioned_at: '2031-04-02T18:30:00.000Z',
        }),
      ],
      omitted: 0,
    });
    expect(content.memory_evidence.emails[0].text).toContain('To: ada@example.test');
    expect(content.memory_evidence.emails[0].text).toContain(email().bodyClean);
  });

  it('deduplicates references and excludes unknown mailboxes and uncached IDs', () => {
    const content = JSON.parse(prepare(['ada:111', 'ada:111', 'ada:222', 'unknown:111', 'not an id']).content);
    expect(content.memory_evidence.emails).toHaveLength(1);
    expect(content.memory_evidence.omitted).toBe(3);
  });

  it('captures complete originals beyond one model request budget', () => {
    for (const gmMsgId of ['abc', '2', '3', '4'])
      putCachedMessage(email({ gmMsgId, bodyClean: 'source '.repeat(3000) }));
    const content = JSON.parse(prepare(['ada:ABC', 'ada:abc', 'ada:2', 'ada:3', 'ada:4']).content);
    expect(content.memory_evidence.emails).toHaveLength(4);
    expect(content.memory_evidence.emails.map((item: { item_id: string }) => item.item_id)).toEqual([
      'email:ada:abc',
      'email:ada:2',
      'email:ada:3',
      'email:ada:4',
    ]);
    expect(content.memory_evidence.omitted).toBe(0);
    expect(content.memory_evidence.emails[0].text).toContain('source '.repeat(3000));
  });

  it.each([
    ['oversized body', { bodyClean: 'x'.repeat(95_001) }],
    ['credential', { bodyClean: 'password: invented_credential_123456789' }],
    ['date without a clock', { internalAt: '2031-04-02' }],
    ['truncated body', { removed: { quotedLines: 0, signatureLines: 0, truncatedChars: 12 } }],
  ] as const)('omits %s without clipping away its qualification', (_label, overrides) => {
    useInMemoryMailDb();
    putCachedMessage(email(overrides));
    expect(JSON.parse(prepare().content).memory_evidence).toEqual({ emails: [], omitted: 1 });
  });

  it('ignores forged evidence and keeps ordinary chat and learn-off free of evidence', () => {
    const forged = { emails: [{ text: 'invented confirmation' }], omitted: 0 };
    expect(JSON.parse(prepare([], { memory_evidence: forged }).content).memory_evidence).toBeUndefined();
    const ordinary = prepareScheduledReport(db, { id: 'chat', kind: 'chat', content: prepare().content });
    expect(JSON.parse(ordinary.content).memory_evidence).toBeUndefined();
    const peer = prepareScheduledReport(db, {
      id: 'peer',
      kind: 'chat',
      channel_type: 'agent',
      in_reply_to: 'run-a',
      content: JSON.stringify({ text: 'A report for another agent', source_email_ids: ['ada:111'] }),
    });
    expect(JSON.parse(peer.content).memory_evidence).toBeUndefined();
    setSessionState(db, 'learn_enabled', 'false');
    expect(JSON.parse(prepare().content).memory_evidence).toBeUndefined();
  });

  it('automatically hands off run-scoped read evidence when the report omits source IDs', () => {
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'run-a'").run();
    recordScheduledEmailReads(db, ['ada:111']);
    useInMemoryMailDb();
    const report = prepareScheduledReport(db, {
      id: 'automatic',
      kind: 'chat',
      in_reply_to: 'run-a',
      content: JSON.stringify({ text: 'Bo proposed a review for Ada; EUR 1111 remains pending.' }),
    });
    expect(JSON.parse(report.content).memory_evidence.emails[0].text).toContain(email().bodyClean);
    // Explicit selections use the captured bytes even after cache eviction.
    expect(JSON.parse(prepare().content).memory_evidence.emails).toHaveLength(1);
    const unrelated = prepareScheduledReport(db, {
      id: 'other',
      kind: 'chat',
      in_reply_to: 'other-run',
      content: report.content,
    });
    expect(JSON.parse(unrelated.content).memory_evidence).toBeUndefined();
  });

  it('does not select a cached original that was not read by this run', () => {
    putCachedMessage(email({ gmMsgId: '222', bodyClean: 'An unrelated earlier record.' }));
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'run-a'").run();
    recordScheduledEmailReads(db, ['ada:111']);
    expect(JSON.parse(prepare(['ada:222']).content).memory_evidence).toEqual({ emails: [], omitted: 1 });
  });

  it('never associates ordinary reads or an ambiguous processing batch with a scheduled run', () => {
    recordScheduledEmailReads(db, ['ada:111']);
    expect(JSON.parse(prepare(undefined).content).memory_evidence.emails).toHaveLength(1);
    insertTask(db, {
      id: 'run-b',
      processAfter: '2031-04-03T07:00:00.000Z',
      recurrence: null,
      platformId: 'invented-chat',
      channelType: 'telegram',
      threadId: null,
      content: '{}',
    });
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE kind = 'task'").run();
    recordScheduledEmailReads(db, ['ada:111']);
    useInMemoryMailDb();
    expect(JSON.parse(prepare([]).content).memory_evidence).toBeUndefined();
  });

  it('replaces an omitted truncated source after a complete read, without double counting', () => {
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'run-a'").run();
    putCachedMessage(email({ removed: { quotedLines: 0, signatureLines: 0, truncatedChars: 12 } }));
    recordScheduledEmailReads(db, ['ada:111']);
    expect(JSON.parse(prepare().content).memory_evidence).toEqual({ emails: [], omitted: 1 });
    putCachedMessage(email());
    recordScheduledEmailReads(db, ['ada:111']);
    expect(JSON.parse(prepare().content).memory_evidence.emails).toHaveLength(1);
    expect(JSON.parse(prepare().content).memory_evidence.omitted).toBe(0);
  });

  it('honors explicit selections and prevents acknowledgements from expanding them', () => {
    db.prepare("UPDATE messages_in SET status = 'processing' WHERE id = 'run-a'").run();
    putCachedMessage(email({ gmMsgId: '222', bodyClean: 'An unrelated newsletter.' }));
    recordScheduledEmailReads(db, ['ada:111', 'ada:222']);
    const ack = () =>
      JSON.parse(
        prepareScheduledReport(db, {
          id: 'ack',
          kind: 'chat',
          in_reply_to: 'run-a',
          content: JSON.stringify({ text: 'Report sent.' }),
        }).content,
      ).memory_evidence;
    expect(JSON.parse(prepare().content).memory_evidence.emails).toHaveLength(1);
    expect(ack().emails.map((item: { item_id: string }) => item.item_id)).toEqual(['email:ada:111']);
    recordScheduledEmailReads(db, ['ada:222']);
    expect(ack().emails).toHaveLength(1);
    expect(JSON.parse(prepare([]).content).memory_evidence).toEqual({ emails: [], omitted: 0 });
    expect(ack()).toEqual({ emails: [], omitted: 0 });
  });

  it('replays the persisted report bytes after the mail cache disappears', () => {
    const first = prepare();
    insertOutboundMessage(db, first);
    useInMemoryMailDb();
    expect(prepare().content).toBe(first.content);
    expect(JSON.parse(prepare().content).memory_evidence.emails).toHaveLength(1);
  });
});
