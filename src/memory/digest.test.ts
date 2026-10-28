import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = '/tmp/luna-test-digest';

vi.mock('../config/paths.js', () => ({
  configDir: () => '/tmp/luna-test-digest/config',
  defaultConfigPath: () => '/tmp/luna-test-digest/config/default.jsonc',
  localConfigPath: () => '/tmp/luna-test-digest/config/local.jsonc',
}));

/**
 * Roster resolution is stubbed: these tests are about the eligibility *rules*, and binding needs the
 * central DB, which this file does not open. `rosterKey = null` is the "sender is not configured" case.
 */
let rosterKey: string | null = 'ada';
vi.mock('../users/binding.js', () => ({
  resolveUserKey: () => rosterKey,
  isOwner: () => true,
  ownerIdentities: () => [],
  hotMemorySlugFor: () => null,
  bindUserKey: () => {},
}));

let memoryFailure: Error | null = null;
let loseReceipt = false;
interface CapturedRetainItem {
  item_id: string;
  text: string;
  role?: string;
  speaker?: string;
  mentioned_at?: string;
}
interface CapturedRetainSource {
  source_id: string;
  revision: string;
  source_group?: string;
  source_kind?: string;
  mentioned_at?: string;
  timezone?: string;
  locator?: string;
  input: { items: CapturedRetainItem[] };
  retention: { mode: string; mission?: string };
}
/** What the last digest handed memory, captured at the protocol boundary. */
let lastRetain: { sources: CapturedRetainSource[] } | null = null;
let retainResult: Record<string, unknown> = { outcome: 'noop', status: 'empty', candidates: [] };
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js');
  return {
    ...actual,
    withMemory: async (work: (client: unknown) => Promise<unknown>) => {
      if (memoryFailure) throw memoryFailure;
      return work({
        retain: async (input: { sources: CapturedRetainSource[] }) => {
          lastRetain = input;
          if (loseReceipt) {
            loseReceipt = false;
            throw new Error('the connection is closed');
          }
          const source = input.sources[0]!;
          return {
            outcome: retainResult.outcome === 'ok' ? 'ok' : 'noop',
            status: retainResult.status ?? 'ok',
            sources: [{ source_id: source.source_id, revision: source.revision, ...retainResult }],
          };
        },
      });
    },
  };
});

import { clearConfigCache } from '../config/loader.js';
import {
  ensureSchema,
  getSessionState,
  insertOutboundMessage,
  openSessionDb,
  setSessionState,
} from '../db/session-db.js';
import { insertTask } from '../modules/scheduling/db.js';
import {
  agentWroteForTesting,
  describeDigest,
  evaluateEligibility,
  forwardedFrom,
  looksLikeSecret,
  noteAgentMemoryPages,
  noteAgentMemoryWriteFromTool,
  pagesTouchedSinceForTesting,
  notePendingDigest,
  notePendingDigestReply,
  notePendingScheduledReply,
  queueScheduledReportCorrection,
  recoverScheduledReports,
  recordDigestWritesForTesting,
  runPendingDigest,
  repliedTo,
  resetAgentWritesForTesting,
  userTurnText,
  type DigestOutcome,
} from './digest.js';
import { AknoError } from '@tenphi/akno-client';
import { MemoryUnavailable } from './client.js';
import type { MessagingGroup } from '../types.js';

/**
 * What Luna still decides about learning from a conversation, now that memory does the deciding
 * about *what* to keep. Two things, and both are here because both have teeth: which messages are
 * eligible at all, and what the owner is told afterwards.
 */

const dm: MessagingGroup = {
  id: 'mg-1',
  channel_type: 'telegram',
  platform_id: '123',
  name: null,
  is_group: 0,
  created_at: '2026-08-07T00:00:00.000Z',
};

const group: MessagingGroup = { ...dm, id: 'mg-2', is_group: 1 };

function writeConfig(memory: Record<string, unknown>): void {
  fs.mkdirSync(path.join(TEST_DIR, 'config'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'config/default.jsonc'), JSON.stringify({ memory }, null, 2) + '\n');
  clearConfigCache();
}

let replySequence = 0;
function noteReply(db: Database.Database, text: string): void {
  replySequence += 1;
  notePendingDigestReply(db, { itemId: `reply-${replySequence}`, text, at: Date.now() });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  writeConfig({ enabled: true, digest: true, notify: 'pages' });
  memoryFailure = null;
  loseReceipt = false;
  retainResult = { outcome: 'noop', status: 'empty', candidates: [] };
  replySequence = 0;
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  clearConfigCache();
});

describe('what is eligible to learn from', () => {
  it('learns from a DM by a configured user', () => {
    const result = evaluateEligibility({
      messagingGroup: dm,
      userId: 'telegram:1',
      kind: 'chat',
      rawContent: JSON.stringify({ text: 'The rent goes up to 1250 EUR in September.' }),
    });
    expect(result.eligible).toBe(true);
    expect(result.text).toBe('The rent goes up to 1250 EUR in September.');
  });

  it('never learns from a sender the roster does not name', () => {
    // The CLI messaging group bypasses the access gate, so eligibility cannot lean on the gate
    // having refused an unconfigured sender first.
    rosterKey = null;
    try {
      const result = evaluateEligibility({
        messagingGroup: dm,
        userId: 'telegram:stranger',
        kind: 'chat',
        rawContent: JSON.stringify({ text: 'The rent goes up to 1250 EUR in September.' }),
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('not_in_roster');
    } finally {
      rosterKey = 'ada';
    }
  });

  it('never learns from a group chat', () => {
    // Other people talking. Inferring the owner's preferences from it is how a knowledge base
    // fills up with confident claims about the wrong person.
    const result = evaluateEligibility({
      messagingGroup: group,
      userId: 'telegram:1',
      kind: 'chat',
      rawContent: JSON.stringify({ text: 'I love pineapple on pizza.' }),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('group_chat');
  });

  it('never learns from an unidentified sender', () => {
    const result = evaluateEligibility({
      messagingGroup: dm,
      userId: null,
      kind: 'chat',
      rawContent: JSON.stringify({ text: 'My IBAN is NL00 TEST 0000 0000 00.' }),
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('unknown_user');
  });

  it('skips slash commands and attachment-only messages', () => {
    for (const [raw, reason] of [
      [JSON.stringify({ text: '/learn off' }), 'slash_command'],
      [JSON.stringify({ attachments: [{ name: 'scan.pdf' }] }), 'empty_text'],
    ] as const) {
      const result = evaluateEligibility({ messagingGroup: dm, userId: 'telegram:1', kind: 'chat', rawContent: raw });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe(reason);
    }
  });

  it('rejects a single message larger than the retain item contract', () => {
    const result = evaluateEligibility({
      messagingGroup: dm,
      userId: 'telegram:1',
      kind: 'chat',
      rawContent: JSON.stringify({ text: 'x'.repeat(100_001) }),
    });
    expect(result).toMatchObject({ eligible: false, reason: 'too_large' });
  });

  it('refuses anything that looks like a credential', () => {
    // The one input where "remember this" is exactly wrong: it would be written to a Markdown file,
    // indexed, embedded, and read back later in front of whoever is looking. Errs toward refusing —
    // a missed digest costs a fact, a missed secret costs a secret.
    const secrets = [
      'my key is sk-' + 'abcdefghijklmnopqrstuvwxyz012345',
      'token: ' + '0123456789'.repeat(2),
      'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123',
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      'the password = correct-horse-battery',
    ];
    for (const text of secrets) {
      expect(looksLikeSecret(text)).toBe(true);
      const result = evaluateEligibility({
        messagingGroup: dm,
        userId: 'telegram:1',
        kind: 'chat',
        rawContent: JSON.stringify({ text }),
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('secret_detected');
    }
  });

  it('does not mistake ordinary talk about accounts for a credential', () => {
    for (const text of [
      'I changed my password yesterday, finally.',
      'The bank sent a new token generator in the post.',
      'Ask Brannoch for the API key when you see him.',
    ]) {
      expect(looksLikeSecret(text)).toBe(false);
    }
  });

  it('reads the user’s own words out of the payload', () => {
    expect(userTurnText(JSON.stringify({ text: '  spaced  ' }))).toBe('spaced');
    expect(userTurnText('plain text, not json')).toBe('plain text, not json');
    expect(userTurnText('')).toBeNull();
  });
});

describe('what travels with the text', () => {
  it('names the original author of a forward', () => {
    // A forward is somebody else's words, so its facts are theirs. Without this a spouse's
    // membership number, forwarded verbatim, lands on the forwarder's own page.
    const raw = JSON.stringify({ text: 'my number is 88-4120', forwardedFrom: { from: 'Brannoch' } });
    expect(forwardedFrom(raw)).toBe('Brannoch');
    expect(forwardedFrom(JSON.stringify({ text: 'mine' }))).toBeUndefined();
  });

  it('carries the quoted message when a reply needs it', () => {
    const raw = JSON.stringify({ text: 'yes, that one', replyTo: { text: 'shall we take the 9am viewing?' } });
    expect(repliedTo(raw)).toBe('shall we take the 9am viewing?');
  });
});

describe('what the owner is told', () => {
  it('distinguishes an empty scheduled run from an unavailable save', () => {
    expect(
      describeDigest({
        wrote: [],
        held: [],
        changeId: null,
        scheduled: { runId: 'run-1', status: 'empty', outcome: 'noop', degraded: [] },
      }),
    ).toBe('No new memories were saved from the scheduled report.');
    expect(
      describeDigest({
        wrote: [],
        held: [],
        changeId: null,
        scheduled: { runId: 'run-1', status: 'unavailable', outcome: 'unavailable', degraded: [] },
      }),
    ).toContain('queued for retry');
  });
  const wrote: DigestOutcome = {
    wrote: [{ slug: 'household/lease' }, { slug: 'household/utilities' }],
    held: [],
    changeId: 'chg_abc123',
  };

  it('names every page in the content-free receipt', () => {
    // Akno deliberately does not echo private retained text through a host receipt. The configured
    // notification promises page names, which are enough to inspect or undo the change.
    const note = describeDigest(wrote)!;
    expect(note).toContain('household/lease');
    expect(note).toContain('household/utilities');
    expect(note).toContain('undo that');
  });

  it('reports typed holds without claiming they were saved', () => {
    const note = describeDigest({
      wrote: [],
      held: [
        {
          code: 'routing_uncertain',
          reason: 'no admitted writable destination could be established',
        },
      ],
      changeId: null,
    })!;
    expect(note).toContain('not retained safely');
    expect(note).toContain('routing_uncertain');
    expect(note).not.toContain('Remembered');
  });

  it('says nothing when nothing happened', () => {
    // The common case by far: most messages contain nothing durable, and a 🧠 note on every turn
    // trains the owner to ignore it.
    expect(describeDigest({ wrote: [], held: [], changeId: null })).toBeNull();
  });

  it('is silent when the owner turned notifications off', () => {
    writeConfig({ enabled: true, digest: true, notify: 'off' });
    expect(describeDigest(wrote)).toBeNull();
  });

  it('reports only candidates the retain receipt confirms as written', async () => {
    retainResult = {
      outcome: 'ok',
      status: 'ok',
      candidates: [
        {
          candidate_id: 'held-1',
          outcome: 'held',
          slug: 'games/ember-archive',
          reason_code: 'no_writable_destination',
          reason: 'no admitted writable destination could be established',
        },
        {
          candidate_id: 'written-1',
          outcome: 'written',
          slug: 'knowledge/networking/blackwater-fibre',
        },
      ],
      change_id: 'chg_confirmed',
    };

    const dbPath = path.join(TEST_DIR, 'confirmed-writes.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      notePendingDigest(db, { itemId: 'in-confirmed', text: 'Two findings.', at: Date.now() });
      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'confirmed' });
      expect(outcome?.wrote).toEqual([{ slug: 'knowledge/networking/blackwater-fibre' }]);
      expect(outcome?.held).toEqual([
        {
          code: 'no_writable_destination',
          reason: 'no admitted writable destination could be established',
        },
      ]);
      expect(describeDigest(outcome!)!).not.toContain('games/ember-archive');
    } finally {
      db.close();
    }
  });

  it('does not count an aggregate held outcome as a second rejected item', async () => {
    retainResult = {
      outcome: 'held',
      status: 'ok',
      candidates: [
        {
          candidate_id: 'held-1',
          outcome: 'held',
          reason_code: 'validation_failed',
          reason: 'candidate text is not one bounded self-contained statement',
        },
      ],
    };

    const dbPath = path.join(TEST_DIR, 'one-held-item.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      notePendingDigest(db, { itemId: 'in-held', text: 'A reference guide.', at: Date.now() });
      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'held-once' });
      expect(outcome?.held).toEqual([
        {
          code: 'validation_failed',
          reason: 'candidate text is not one bounded self-contained statement',
        },
      ]);
      expect(describeDigest(outcome!)!).toContain('1 item(s) were not retained safely');
    } finally {
      db.close();
    }
  });

  it('counts all held candidates while grouping repeated explanations', async () => {
    const reasons = [
      'time_unresolved',
      'discourse_uncertain',
      'discourse_uncertain',
      'routing_uncertain',
      'routing_uncertain',
    ];
    retainResult = {
      outcome: 'held',
      status: 'ok',
      candidates: reasons.map((code, i) => ({
        candidate_id: `held-${i}`,
        outcome: 'held',
        reason_code: code,
        reason: `Fixture ${code}`,
      })),
    };
    const dbPath = path.join(TEST_DIR, 'five-held-items.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      notePendingDigest(db, { itemId: 'in-held-five', text: 'An invented report.', at: Date.now() });
      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'held-five' });
      expect(outcome?.held).toHaveLength(5);
      const notice = describeDigest(outcome!)!;
      expect(notice).toContain('5 item(s) were not retained safely');
      expect(notice.match(/• /g)).toHaveLength(3);
      expect(notice).toContain('2 items: Fixture discourse_uncertain');
      expect(notice).toContain('2 items: Fixture routing_uncertain');
    } finally {
      db.close();
    }
  });
});

describe('scheduled report retention', () => {
  function scheduledDb(name: string): Database.Database {
    const dbPath = path.join(TEST_DIR, `${name}.db`);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    return openSessionDb(dbPath);
  }

  it('recovers original email evidence with its own clock and retries exactly the sealed bytes', async () => {
    const dbPath = path.join(TEST_DIR, 'scheduled-email-source.db');
    let db = scheduledDb('scheduled-email-source');
    const options = { agentGroupId: 'ag', sessionId: 'scheduled-email-source' };
    const evidence = {
      emails: [
        {
          item_id: 'email:ada:111',
          role: 'external' as const,
          speaker: 'Bo Winters <bo@example.test>',
          mentioned_at: '2031-04-02T18:30:00.000Z',
          text: 'From: Bo Winters <bo@example.test>\nTo: ada@example.test\nSubject: Proposed review\n\nThe review is tomorrow. EUR 1111 is pending, not settled. No booking is confirmed.',
        },
      ],
      omitted: 1,
    };
    try {
      setSessionState(db, 'memory:scheduled-recovery-cursor', '0');
      insertTask(db, {
        id: 'email-run',
        processAfter: '2031-04-03T07:00:00.000Z',
        recurrence: null,
        platformId: 'invented-chat',
        channelType: 'telegram',
        threadId: null,
        content: '{}',
      });
      for (const id of ['email-report-1', 'email-report-2']) {
        insertOutboundMessage(db, {
          id,
          in_reply_to: 'email-run',
          kind: 'chat',
          content: JSON.stringify({
            text: 'Bo proposed a review for Ada on 3 April 2031; EUR 1111 remains pending and the booking unconfirmed.',
            memory_evidence: evidence,
          }),
        });
      }
      db.close();
      db = openSessionDb(dbPath);
      expect(recoverScheduledReports(db)).toBe(2);
      loseReceipt = true;
      await runPendingDigest(db, options);
      const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!);
      expect(sealed.source.input.items).toHaveLength(3);
      expect(sealed.source.input.items[0]).toEqual(evidence.emails[0]);
      expect(sealed.source.input.items[1]).toMatchObject({ role: 'assistant', speaker: 'Luna' });
      expect(sealed.source.input.items[1].text).toContain('Claims without attached evidence');
      expect(sealed.source.input.items[1].mentioned_at).not.toBe(evidence.emails[0].mentioned_at);
      expect(sealed.source.retention.mission).toContain('never the report clock');
      expect(sealed.source.retention.mission).toContain('not to extract unrelated facts');
      expect(sealed.source.retention.mission.length).toBeLessThanOrEqual(2000);
      db.close();
      db = openSessionDb(dbPath);
      await runPendingDigest(db, options);
      expect(lastRetain!.sources[0]).toEqual(sealed.source);
      expect(await runPendingDigest(db, options)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps the report as a replay-safe, attributed source with the scheduled date', async () => {
    const db = scheduledDb('scheduled-source');
    try {
      notePendingScheduledReply(
        db,
        { runId: 'run-a', seriesId: 'daily-a', scheduledFor: '2026-02-03T08:00:00.000Z' },
        {
          itemId: 'reply-a',
          text: 'The fictional Fernbrook library reopened on 2 February 2026, according to its notice.',
          at: Date.parse('2026-02-03T08:03:00.000Z'),
        },
      );
      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-source' });
      expect(outcome?.scheduled?.runId).toBe('run-a');
      const source = lastRetain!.sources[0]!;
      expect(source.source_id).toContain('scheduled:ag:daily-a:run-a');
      expect(source.mentioned_at).toBe('2026-02-03T08:00:00.000Z');
      expect(source.input.items[0]).toMatchObject({
        item_id: 'reply-a',
        role: 'assistant',
        speaker: 'Luna',
        mentioned_at: '2026-02-03T08:03:00.000Z',
      });
      expect(source.retention.mission).toContain('actual event date');
      expect(source.retention.mission).toContain('Dated personal activity can be useful history');
      expect(source.retention.mission).toContain('do not combine its assistant spans with');
      expect(source.retention.mission).toContain(
        'translate only the readable retained sentence, never an evidence quote',
      );
      expect(source.retention.mission).toContain('pending versus settled');
      expect(source.retention.mission).toContain('not live price quotes');
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
      expect(await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-source' })).toBeNull();
    } finally {
      db.close();
    }
  });

  it('batches a split report without dropping any complete original', async () => {
    const db = scheduledDb('scheduled-source-budget');
    try {
      const body = 'Complete original, including qualifications. '.repeat(450);
      for (let n = 0; n < 4; n++)
        notePendingScheduledReply(
          db,
          { runId: 'budget-run', seriesId: 'budget-series', scheduledFor: '2031-04-03T07:00:00.000Z' },
          {
            itemId: `report-${n}`,
            text: `Invented personal finding ${n}.`,
            at: Date.now(),
            evidence: {
              omitted: 0,
              emails: [
                {
                  item_id: `email:ada:${n}`,
                  role: 'external',
                  speaker: 'Bo Winters',
                  mentioned_at: '2031-04-02T18:30:00.000Z',
                  text: body,
                },
              ],
            },
          },
        );
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-source-budget' });
      const originals = lastRetain!.sources[0].input.items.filter((item) => item.role === 'external');
      expect(lastRetain!.sources[0].retention.mission!.length).toBeLessThanOrEqual(2000);
      expect(originals).toHaveLength(3);
      expect(originals.every((item) => item.text === body)).toBe(true);
      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-source-budget' });
      const remaining = lastRetain!.sources[0].input.items.filter((item) => item.role === 'external');
      expect(lastRetain!.sources[0].retention.mission!.length).toBeLessThanOrEqual(2000);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.text).toBe(body);
      expect(outcome?.counts).toMatchObject({ evidenceOmitted: 0, batchesCompleted: 2, batchesTotal: 2 });
    } finally {
      db.close();
    }
  });

  it('resumes the uncertain batch after restart without replaying completed siblings', async () => {
    const name = 'scheduled-batch-restart';
    let db = scheduledDb(name);
    const options = { agentGroupId: 'ag', sessionId: name };
    try {
      notePendingScheduledReply(
        db,
        { runId: 'multi-run', seriesId: 'multi-series', scheduledFor: '2031-04-03T07:00:00Z' },
        {
          itemId: 'multi-report',
          text: 'Three invented personal notices.',
          at: Date.now(),
          evidence: {
            omitted: 0,
            emails: [1, 2, 3].map((n) => ({
              item_id: `email:ada:${n}`,
              text: `Source ${n}: ` + 'x'.repeat(40_000) + ' Pending, not settled.',
              role: 'external' as const,
              speaker: 'Bo Winters',
              mentioned_at: '2031-04-02T18:30:00Z',
            })),
          },
        },
      );
      retainResult = {
        outcome: 'ok',
        status: 'ok',
        candidates: [{ candidate_id: 'first', outcome: 'written', slug: 'notes/first' }],
      };
      expect(await runPendingDigest(db, options)).toBeNull();
      const completed = lastRetain!.sources[0].source_id;
      loseReceipt = true;
      await runPendingDigest(db, options);
      const uncertain = lastRetain!.sources[0];
      expect(uncertain.source_id).not.toBe(completed);
      db.close();
      db = openSessionDb(path.join(TEST_DIR, `${name}.db`));
      retainResult = {
        outcome: 'ok',
        status: 'degraded',
        candidates: [
          {
            candidate_id: 'held',
            outcome: 'held',
            reason_code: 'discourse_uncertain',
            reason: 'verification unavailable or invalid',
          },
        ],
      };
      expect(await runPendingDigest(db, options)).toBeNull();
      expect(lastRetain!.sources[0]).toEqual(uncertain);
      retainResult = { outcome: 'ok', status: 'ok', candidates: [{ candidate_id: 'last', outcome: 'duplicate' }] };
      const outcome = await runPendingDigest(db, options);
      expect(outcome?.counts).toMatchObject({
        saved: 1,
        alreadyKnown: 1,
        held: 1,
        batchesCompleted: 3,
        batchesTotal: 3,
      });
      expect(outcome?.wrote).toEqual([{ slug: 'notes/first' }]);
      expect(
        describeDigest({ ...outcome!, scheduled: { ...outcome!.scheduled!, status: 'ok', outcome: 'noop' } }),
      ).not.toContain('No new memories');
      expect(describeDigest({ ...outcome!, scheduled: { ...outcome!.scheduled!, status: 'failed' } })).not.toContain(
        'its contents were not saved',
      );
      expect(outcome?.scheduled?.status).toBe('degraded');
      expect(JSON.parse(getSessionState(db, 'memory:retain-review')!)).toHaveLength(1);
      expect(await runPendingDigest(db, options)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('preserves an exhausted batch and continues independent later evidence', async () => {
    const db = scheduledDb('scheduled-batch-failure');
    const options = { agentGroupId: 'ag', sessionId: 'scheduled-batch-failure' };
    try {
      notePendingScheduledReply(
        db,
        { runId: 'failure-run', seriesId: 'failure-series', scheduledFor: '2031-04-03T07:00:00Z' },
        {
          itemId: 'failure-report',
          text: 'Two invented notices.',
          at: Date.now(),
          evidence: {
            omitted: 0,
            emails: [1, 2].map((n) => ({
              item_id: `email:ada:${n}`,
              text: `Source ${n}: ` + 'x'.repeat(40_000),
              role: 'external' as const,
              speaker: 'Bo Winters',
              mentioned_at: '2031-04-02T18:30:00Z',
            })),
          },
        },
      );
      retainResult = { outcome: 'held', status: 'unavailable', candidates: [], retryable: true };
      for (let attempt = 0; attempt < 4; attempt++) {
        const persisted = getSessionState(db, 'memory:retain-inflight');
        if (persisted)
          setSessionState(db, 'memory:retain-inflight', JSON.stringify({ ...JSON.parse(persisted), retryAfter: 0 }));
        await runPendingDigest(db, options);
      }
      expect(JSON.parse(getSessionState(db, 'memory:retain-failed')!)).toHaveLength(1);
      expect(getSessionState(db, 'memory:retain-inflight')).not.toBeNull();
      retainResult = {
        outcome: 'ok',
        status: 'ok',
        candidates: [{ candidate_id: 'independent', outcome: 'written', slug: 'notes/independent' }],
      };
      const outcome = await runPendingDigest(db, options);
      expect(outcome?.counts).toMatchObject({ saved: 1, failedBatches: 1, batchesCompleted: 2 });
      expect(outcome?.scheduled?.status).toBe('degraded');
      expect(describeDigest(outcome!)).toContain('original evidence is preserved for recovery');
    } finally {
      db.close();
    }
  });

  it('retries the same scheduled source after an uncertain connection loss', async () => {
    const db = scheduledDb('scheduled-retry');
    try {
      notePendingScheduledReply(
        db,
        { runId: 'run-b', seriesId: 'daily-b', scheduledFor: '2026-02-03T08:00:00.000Z' },
        { itemId: 'reply-b', text: 'An invented dated notice.', at: Date.now() },
      );
      memoryFailure = new MemoryUnavailable('test connection loss');
      const first = await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-retry' });
      expect(first?.scheduled?.status).toBe('unavailable');
      const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!) as { source: CapturedRetainSource };
      memoryFailure = null;
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-retry' });
      expect(lastRetain!.sources[0]).toEqual(sealed.source);
    } finally {
      db.close();
    }
  });

  it('keeps an exact source after a retryable extraction failure and retries after restart', async () => {
    const dbPath = path.join(TEST_DIR, 'scheduled-extraction.db');
    let db = scheduledDb('scheduled-extraction');
    const options = { agentGroupId: 'ag', sessionId: 'scheduled-extraction' };
    try {
      notePendingScheduledReply(
        db,
        { runId: 'run-extraction', seriesId: 'daily', scheduledFor: '2031-04-03T07:00:00Z' },
        { itemId: 'report', text: 'Vulpine Mutual reported EUR 1111 pending for Ada Marlow.', at: Date.now() },
      );
      retainResult = {
        outcome: 'held',
        status: 'degraded',
        candidates: [],
        retryable: true,
        degraded: ['derive_failed'],
      };
      const first = await runPendingDigest(db, options);
      expect(describeDigest(first!)).toContain('queued for retry');
      const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!);
      expect(sealed.extractionAttempts).toBe(1);
      expect(sealed.retryFailed).toBe(true);
      expect(getSessionState(db, 'memory:scheduled-completed')).toBeNull();
      expect(await runPendingDigest(db, options)).toBeNull();
      db.close();
      db = openSessionDb(dbPath);
      setSessionState(db, 'memory:retain-inflight', JSON.stringify({ ...sealed, retryAfter: 0 }));
      retainResult = {
        outcome: 'ok',
        status: 'ok',
        candidates: [{ candidate_id: 'payment', outcome: 'written', slug: 'notes/payment' }],
      };
      const result = await runPendingDigest(db, options);
      expect(lastRetain?.sources[0]).toEqual(sealed.source);
      expect(lastRetain).toHaveProperty('retry_failed', true);
      expect(result?.wrote).toEqual([{ slug: 'notes/payment' }]);
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
      expect(JSON.parse(getSessionState(db, 'memory:scheduled-completed')!)).toContain('run-extraction');
    } finally {
      db.close();
    }
  });

  it('archives repeated extraction failures without claiming completion or losing the sealed source', async () => {
    const db = scheduledDb('scheduled-exhausted');
    try {
      notePendingScheduledReply(
        db,
        { runId: 'run-exhausted', seriesId: 'daily', scheduledFor: '2031-04-03T07:00:00Z' },
        { itemId: 'report', text: 'Vulpine Mutual reported EUR 1111 pending for Ada Marlow.', at: Date.now() },
      );
      retainResult = { outcome: 'held', status: 'degraded', candidates: [], retryable: true };
      for (let attempt = 0; attempt < 4; attempt++) {
        const sealed = getSessionState(db, 'memory:retain-inflight');
        if (sealed)
          setSessionState(db, 'memory:retain-inflight', JSON.stringify({ ...JSON.parse(sealed), retryAfter: 0 }));
        await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-exhausted' });
      }
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
      expect(getSessionState(db, 'memory:scheduled-completed')).toBeNull();
      expect(JSON.parse(getSessionState(db, 'memory:retain-failed')!)[0].source).toEqual(lastRetain?.sources[0]);
    } finally {
      db.close();
    }
  });

  it('keeps a timed-out scheduled report until its stored receipt can be reconciled', async () => {
    const dbPath = path.join(TEST_DIR, 'scheduled-timeout.db');
    let db = scheduledDb('scheduled-timeout');
    const options = { agentGroupId: 'ag', sessionId: 'scheduled-timeout' };
    try {
      notePendingScheduledReply(
        db,
        { runId: 'run-timeout', seriesId: 'daily-timeout', scheduledFor: '2026-02-03T08:00:00.000Z' },
        {
          itemId: 'reply-timeout',
          text: 'The fictional Fernbrook library reopened on 2 February 2026, according to its notice.',
          at: Date.parse('2026-02-03T08:03:00.000Z'),
        },
      );
      memoryFailure = new AknoError('unavailable', 'retain did not respond within 300000ms');
      const first = await runPendingDigest(db, options);
      expect(first?.scheduled?.status).toBe('unavailable');
      expect(describeDigest(first!)).toContain('queued for retry');
      const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!) as {
        source: CapturedRetainSource;
        attempts: number;
        retryAfter: number;
      };
      expect(sealed.attempts).toBe(1);
      expect(sealed.retryAfter).toBeGreaterThan(Date.now() + 5 * 60_000);
      expect(getSessionState(db, 'memory:scheduled-completed')).toBeNull();

      db.close();
      db = openSessionDb(dbPath);
      memoryFailure = null;
      retainResult = {
        status: 'ok',
        outcome: 'ok',
        change_id: 'chg_library',
        candidates: [{ candidate_id: 'library', outcome: 'written', slug: 'community/library', timeline: 'timeline' }],
      };
      expect(await runPendingDigest(db, options)).toBeNull();
      expect(getSessionState(db, 'memory:retain-inflight')).not.toBeNull();
      setSessionState(db, 'memory:retain-inflight', JSON.stringify({ ...sealed, retryAfter: 0 }));
      const reconciled = await runPendingDigest(db, options);
      expect(lastRetain!.sources[0]).toEqual(sealed.source);
      expect(reconciled?.wrote).toEqual([{ slug: 'community/library', timeline: 'timeline' }]);
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
      expect(JSON.parse(getSessionState(db, 'memory:scheduled-completed')!)).toContain('run-timeout');
      expect(await runPendingDigest(db, options)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('recovers a persisted report whose queue write was lost and never repeats a completed run', async () => {
    const db = scheduledDb('scheduled-recovery');
    try {
      setSessionState(db, 'memory:scheduled-recovery-cursor', '0');
      insertTask(db, {
        id: 'run-c',
        processAfter: '2026-02-03T08:00:00.000Z',
        recurrence: null,
        platformId: 'invented-chat',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ prompt: 'Check the fictional library notice.' }),
      });
      insertOutboundMessage(db, {
        id: 'reply-c',
        in_reply_to: 'run-c',
        kind: 'chat',
        content: JSON.stringify({
          text: 'The fictional Fernbrook library reopened on 2 February 2026, according to its notice.',
        }),
      });
      expect(recoverScheduledReports(db)).toBe(1);
      expect(recoverScheduledReports(db)).toBe(0);
      expect(JSON.parse(getSessionState(db, 'memory:scheduled-pending')!)).toHaveLength(1);
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-recovery' });
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();

      notePendingScheduledReply(
        db,
        { runId: 'run-c', seriesId: 'run-c', scheduledFor: '2026-02-03T08:00:00.000Z' },
        { itemId: 'reply-c', text: 'Same report', at: Date.now() },
      );
      expect(JSON.parse(getSessionState(db, 'memory:scheduled-pending')!)).toHaveLength(0);
      expect(await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'scheduled-recovery' })).toBeNull();
    } finally {
      db.close();
    }
  });

  it.each(['written', 'held'] as const)(
    'retains a corrected report once under the original identity (outcome=%s)',
    async (candidateOutcome) => {
      let db = scheduledDb('scheduled-correction');
      const options = { agentGroupId: 'ag', sessionId: 'scheduled-correction' };
      const run = { runId: 'corrected-run', seriesId: 'corrected-run', scheduledFor: '2031-04-03T07:00:00.000Z' };
      const email = {
        item_id: 'email:ada:111',
        role: 'external' as const,
        speaker: 'Bo Winters <bo@example.test>',
        mentioned_at: '2031-04-02T18:30:00.000Z',
        text: 'From: Bo Winters <bo@example.test>\nTo: ada@example.test\n\nThe Zephyr prototype was delivered on 2 April 2031.',
      };
      const report = 'Bo confirmed that the Zephyr prototype was delivered on 2 April 2031.';
      const evidence = { emails: [email], omitted: 0, findings: [{ text: report, item_ids: [email.item_id] }] };
      try {
        insertTask(db, {
          id: run.runId,
          processAfter: run.scheduledFor,
          recurrence: null,
          platformId: 'invented-chat',
          channelType: 'telegram',
          threadId: null,
          content: '{}',
        });
        db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(run.runId);
        notePendingScheduledReply(db, run, {
          itemId: 'failure-reply',
          text: 'The digest could not be delivered.',
          at: Date.parse(run.scheduledFor),
          evidence: { emails: [email], omitted: 0 },
        });
        retainResult = {
          outcome: 'held',
          status: 'degraded',
          candidates: [
            {
              candidate_id: 'held',
              outcome: 'held',
              reason_code: 'verification_failed',
              reason: 'Independent verification failed',
            },
          ],
        };
        await runPendingDigest(db, options);
        const original = lastRetain!.sources[0]!;
        const review = getSessionState(db, 'memory:retain-review');
        // Simulate a historical completion from before the content manifest existed.
        db.prepare("DELETE FROM session_state WHERE key = 'memory:scheduled-report-versions'").run();
        for (const id of ['corrected-report', 'same-report-new-delivery'])
          insertOutboundMessage(db, {
            id,
            in_reply_to: run.runId,
            kind: 'chat',
            content: JSON.stringify({ text: report, memory_evidence: evidence }),
          });
        notePendingScheduledReply(db, run, { itemId: 'corrected-report', text: report, at: Date.now(), evidence });
        expect(await runPendingDigest(db, options)).toBeNull();
        expect(queueScheduledReportCorrection(db, { ...options, reportId: 'corrected-report' }).outcome).toBe('queued');
        const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!);
        expect(sealed.source.source_id).toBe(original.source_id);
        expect(sealed.source.source_group).toBe(original.source_group);
        expect(sealed.source.mentioned_at).toBe(original.mentioned_at);
        expect(sealed.source.revision).not.toBe(original.revision);
        expect(sealed.source.input.items[0]).toEqual(email);
        expect(sealed.source.input.items[1].text).toBe(report);
        expect(sealed.retryFailed).toBeUndefined();
        expect(getSessionState(db, 'memory:retain-review')).toBe(review);
        // A lost response keeps the exact new request for reconciliation.
        loseReceipt = true;
        await runPendingDigest(db, options);
        expect(lastRetain!.sources[0]).toEqual(sealed.source);
        db.close();
        db = scheduledDb('scheduled-correction');
        retainResult = {
          outcome: candidateOutcome === 'written' ? 'ok' : 'held',
          status: 'ok',
          ...(candidateOutcome === 'written' ? { change_id: 'chg_corrected' } : {}),
          candidates: [
            {
              candidate_id: 'delivery',
              outcome: candidateOutcome,
              ...(candidateOutcome === 'written'
                ? { slug: 'equipment/zephyr' }
                : { reason_code: 'discourse_uncertain', reason: 'Fixture semantic hold' }),
            },
          ],
        };
        expect((await runPendingDigest(db, options))?.counts?.saved).toBe(candidateOutcome === 'written' ? 1 : 0);
        expect(lastRetain!.sources[0]).toEqual(sealed.source);
        expect(queueScheduledReportCorrection(db, { ...options, reportId: 'same-report-new-delivery' }).outcome).toBe(
          'unchanged',
        );
        expect(await runPendingDigest(db, options)).toBeNull();
        expect(JSON.parse(getSessionState(db, 'memory:retain-review')!).slice(0, 1)).toEqual(JSON.parse(review!));
        insertOutboundMessage(db, {
          id: 'acknowledgement',
          in_reply_to: run.runId,
          kind: 'chat',
          content: JSON.stringify({ text: 'Sent the digest.', memory_evidence: evidence }),
        });
        expect(() => queueScheduledReportCorrection(db, { ...options, reportId: 'acknowledgement' })).toThrow(
          'does not contain the selected report findings',
        );
      } finally {
        db.close();
      }
    },
  );
});

describe('timeline membership in ordinary and scheduled receipts', () => {
  it.each([false, true])(
    'keeps mixed destinations after a lost reply and host restart (scheduled=%s)',
    async (scheduled) => {
      const dbPath = path.join(TEST_DIR, 'timeline-replay.db');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      ensureSchema(dbPath);
      let db = openSessionDb(dbPath);
      const options = { agentGroupId: 'ag', sessionId: 'mixed-timelines' };
      const at = Date.parse('2031-04-03T09:00:00.000Z');
      const text = 'The Zephyr prototype arrived. The fictional home meter was replaced. A case deadline was extended.';
      try {
        if (scheduled)
          notePendingScheduledReply(
            db,
            { runId: 'run-mixed', seriesId: 'series-mixed', scheduledFor: '2031-04-03T08:00:00.000Z' },
            { itemId: 'report-mixed', text, at },
          );
        else notePendingDigest(db, { itemId: 'chat-mixed', text, speaker: 'Ada Marlow', at });
        retainResult = {
          status: 'degraded',
          degraded: ['derive_failed'],
          outcome: 'ok',
          change_id: 'chg_mixed',
          candidates: [
            {
              candidate_id: 'a',
              outcome: 'written',
              slug: 'home/meter',
              timeline: 'timeline',
              timeline_basis: 'source_page',
            },
            {
              candidate_id: 'b',
              outcome: 'written',
              slug: 'work/prototype',
              timeline: 'work/timeline',
              timeline_basis: 'source_page',
            },
            {
              candidate_id: 'c',
              outcome: 'support_added',
              slug: 'case/deadline',
              timeline: 'case/timeline',
              timeline_basis: 'source_page',
            },
            {
              candidate_id: 'd',
              outcome: 'duplicate',
              slug: 'work/older',
              timeline: 'work/timeline',
              timeline_basis: 'source_page',
            },
            {
              candidate_id: 'e',
              outcome: 'held',
              slug: 'unwritable/item',
              timeline: 'unwritable/timeline',
              reason_code: 'routing_uncertain',
              reason: 'No safe placement.',
            },
            {
              candidate_id: 'f',
              outcome: 'written',
              slug: 'work/prototype',
              timeline: 'work/timeline',
              timeline_basis: 'source_page',
            },
          ],
        };
        loseReceipt = true;
        await runPendingDigest(db, options);
        const original = JSON.stringify(lastRetain);
        const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!) as { source: CapturedRetainSource };
        expect(sealed.source).not.toHaveProperty('timeline');
        expect(sealed.source.retention).not.toHaveProperty('timeline');
        expect(sealed.source.input.items[0]!.text).toBe(text);
        expect(sealed.source.mentioned_at).toBe(scheduled ? '2031-04-03T08:00:00.000Z' : '2031-04-03T09:00:00.000Z');
        expect(sealed.source.timezone).toBeTruthy();
        db.close();
        db = openSessionDb(dbPath);
        retainResult.outcome = 'replayed';
        const outcome = await runPendingDigest(db, options);
        expect(JSON.stringify(lastRetain)).toBe(original);
        expect(outcome?.wrote).toEqual([
          { slug: 'home/meter', timeline: 'timeline', timeline_basis: 'source_page' },
          { slug: 'work/prototype', timeline: 'work/timeline', timeline_basis: 'source_page' },
          { slug: 'case/deadline', timeline: 'case/timeline', timeline_basis: 'source_page' },
        ]);
        expect(outcome?.held).toEqual([{ code: 'routing_uncertain', reason: 'No safe placement.' }]);
        const note = describeDigest(outcome!)!;
        expect(note).toContain('only partly available');
        expect(note).toContain('timeline `work/timeline`');
        expect(note).toContain('timeline `case/timeline`');
        expect(note).not.toContain('work/older');
        expect(note).not.toContain('unwritable/item');
        expect(note).not.toContain(text);
        expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
        expect(await runPendingDigest(db, options)).toBeNull();
      } finally {
        db.close();
      }
    },
  );

  it('does not describe an unresolved earlier correction as unavailable memory', () => {
    const held = [{ code: 'not_durable', reason: 'Transient task detail.' }];
    const correction = describeDigest({
      wrote: [],
      held,
      changeId: null,
      status: 'degraded',
      degraded: ['deciding_relation_unavailable'],
    })!;
    expect(correction).toContain('possible correction to an earlier memory');
    expect(correction).not.toContain('only partly available');
    const mixed = describeDigest({
      wrote: [],
      held,
      changeId: null,
      status: 'degraded',
      degraded: ['deciding_relation_unavailable', 'retain_verification_failed'],
    })!;
    expect(mixed).toContain('only partly available');
    expect(mixed).toContain('possible correction to an earlier memory');
  });

  it('describes a refused write as a held save, not unavailable memory', () => {
    const held = [{ code: 'apply_failed', reason: 'source apply failed: no page at people/ada-marlow' }];
    const note = describeDigest({
      wrote: [],
      held,
      changeId: null,
      status: 'degraded',
      degraded: ['retain_apply_failed'],
    })!;
    expect(note).toContain('could not apply a save');
    expect(note).not.toContain('available');
    expect(note).toContain('no page at people/ada-marlow (`apply_failed`)');
    const outage = describeDigest({
      wrote: [{ slug: 'people/bo-winters' }],
      held,
      changeId: 'chg_1111',
      status: 'degraded',
      degraded: ['retain_apply_failed', 'derive_failed'],
    })!;
    expect(outage).toContain('only partly available');
    expect(outage).toContain('could not apply a save');
  });

  it('does not claim an outage for a degraded receipt it cannot explain', () => {
    const held = [{ code: 'not_durable', reason: 'Transient task detail.' }];
    for (const degraded of [undefined, ['a_reason_from_a_newer_akno'], ['source_conflict']]) {
      const note = describeDigest({ wrote: [], held, changeId: null, status: 'degraded', degraded })!;
      expect(note).toContain('Memory reported a problem with this save');
      expect(note).not.toContain('available');
    }
    const known = describeDigest({
      wrote: [],
      held,
      changeId: null,
      status: 'degraded',
      degraded: ['a_reason_from_a_newer_akno', 'retain_apply_failed'],
    })!;
    expect(known).toContain('could not apply a save');
    expect(known).not.toContain('reported a problem');
  });

  it('does not hide a degraded or unavailable empty receipt behind a successful noop', () => {
    for (const status of ['degraded', 'unavailable'] as const) {
      const note = describeDigest({ wrote: [], held: [], changeId: null, status });
      expect(note).toBeTruthy();
      expect(note).not.toContain('Remembered');
    }
  });

  it('distinguishes a terminal unavailable scheduled receipt from a queued transport retry', () => {
    const note = describeDigest({
      wrote: [],
      held: [{ code: 'source_unavailable', reason: 'Source was unavailable.' }],
      changeId: null,
      scheduled: { runId: 'run-unavailable', status: 'unavailable', outcome: 'held', degraded: [] },
    });
    expect(note).toContain('no new save was confirmed');
    expect(note).not.toContain('queued for retry');
    expect(note).not.toContain('Remembered');
  });
});

describe('tracking what the agent already handled', () => {
  it('recognises the tool names the agent actually calls', () => {
    // The bridge exposes a relayed op as `<server>_<op>`, so the agent calls `memory_write`, never
    // bare `write`. Matching only the bare form meant the digest could not exclude prior work, and the same
    // sentence was proposed twice — once by the agent, once by the sweep.
    for (const name of ['memory_write', 'memory_remember', 'memory_retain', 'memory_forget', 'memory_ingest']) {
      expect(() => noteAgentMemoryWriteFromTool('s1', name)).not.toThrow();
      expect(agentWroteForTesting('s1')).toBe(true);
      resetAgentWritesForTesting();
    }
  });

  it('ignores reads and other tools', () => {
    resetAgentWritesForTesting();
    for (const name of ['memory_recall', 'memory_read', 'memory_list', 'Bash', 'send_message', undefined]) {
      noteAgentMemoryWriteFromTool('s2', name);
    }
    expect(agentWroteForTesting('s2')).toBe(false);
  });

  it('still accepts the mcp-qualified and bare forms', () => {
    resetAgentWritesForTesting();
    noteAgentMemoryWriteFromTool('s3', 'mcp__memory__write');
    expect(agentWroteForTesting('s3')).toBe(true);
    resetAgentWritesForTesting();
    noteAgentMemoryWriteFromTool('s4', 'write');
    expect(agentWroteForTesting('s4')).toBe(true);
  });
});

describe('what may be repeated after a dropped socket', () => {
  it('marks only reads as repeatable in the tool wrapper', async () => {
    // A dropped socket says nothing about whether the server finished. Repeating a `recall` costs a
    // search; repeating a `write`, `remember` or `approve` costs a duplicate — which is exactly what
    // happened when a service restart landed in the middle of an approve.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/host-mcp/builtins/memory/servers/memory.ts', 'utf8'),
    );
    const listed = /const REPEATABLE = new Set<MemoryOp>\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '';
    const repeatable = [...listed.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);

    expect(repeatable.sort()).toEqual(['context', 'list', 'read', 'recall', 'timeline']);
    for (const write of ['write', 'remember', 'retain', 'forget', 'undo', 'move', 'ingest']) {
      expect(repeatable).not.toContain(write);
    }
  });
});

describe('telling the episode ledger what was touched', () => {
  it('records the digest’s writes where the container looks for them', async () => {
    // The container decides whether a topic was substantive from `memory:changes`, and the digest
    // writes *after* the turn on the host — so without this the conversations that actually saved
    // something were the ones that looked trivial, and the topic divider stopped appearing.
    const dbPath = path.join(TEST_DIR, 'session.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      recordDigestWritesForTesting(db, ['household/lease', 'people/bran']);
      const raw = getSessionState(db, 'memory:changes');
      expect(raw).not.toBeNull();
      const changes = JSON.parse(raw!) as { slug: string; kind: string; status: string }[];
      expect(changes.map((c) => c.slug)).toEqual(['household/lease', 'people/bran']);
      // The shape the container's reader expects, or the entries are skipped silently.
      expect(changes.every((c) => c.kind === 'page' && c.status === 'applied')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('does not read its own writes back as the agent’s', () => {
    // Both writers share one journal, so the digest can see the entry it wrote a moment ago. Counted
    // as the agent's, it makes the *next* digest stand down — dropping a message that had something
    // worth keeping, and crediting the agent for the digest's own work.
    const dbPath = path.join(TEST_DIR, 'session-self.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      const since = Date.now() - 60_000;
      recordDigestWritesForTesting(db, ['household/lease']);
      expect(pagesTouchedSinceForTesting(db, since)).toEqual([]);

      // A write from the container — the agent's own tool call — still counts.
      const raw = JSON.parse(getSessionState(db, 'memory:changes')!) as unknown[];
      raw.push({
        id: 'c_1',
        action: 'edit',
        kind: 'page',
        slug: 'timeline',
        status: 'applied',
        at: new Date().toISOString(),
      });
      setSessionState(db, 'memory:changes', JSON.stringify(raw));
      expect(pagesTouchedSinceForTesting(db, since)).toEqual(['timeline']);
    } finally {
      db.close();
    }
  });

  it('writes nothing when the digest wrote nothing', () => {
    const dbPath = path.join(TEST_DIR, 'session-empty.db');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    const db = openSessionDb(dbPath);
    try {
      recordDigestWritesForTesting(db, []);
      expect(getSessionState(db, 'memory:changes')).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('telling the owner what the agent itself saved', () => {
  it('names a page the agent wrote when the digest kept nothing of its own', () => {
    // A turn where the agent put an event on the timeline used to read exactly like a turn that
    // saved nothing — a real, undoable change, invisible in the note.
    const note = describeDigest({
      wrote: [],
      held: [],
      changeId: null,
      byAgentPages: ['timeline'],
    })!;
    expect(note).toContain('Saved to memory');
    expect(note).toContain('timeline');
    // Not "Remembered": that word belongs to the digest deciding, and the agent decided here.
    expect(note).not.toContain('Remembered');
  });

  it('reports both when the agent wrote and the digest kept something else', () => {
    // The digest no longer stands down on an agent write, so both are ordinary in one turn: the
    // agent recorded the fact it was asked about, and the digest kept what the answer established.
    const note = describeDigest({
      wrote: [{ slug: 'research/tenancy-law' }],
      held: [],
      changeId: 'chg_1',
      byAgentPages: ['timeline'],
    })!;
    expect(note).toContain('Remembered');
    expect(note).toContain('research/tenancy-law');
    expect(note).toContain('Also saved during the turn');
    expect(note).toContain('timeline');
  });

  it('does not list a page twice when both wrote to it', () => {
    const note = describeDigest({
      wrote: [{ slug: 'household/lease' }],
      held: [],
      changeId: 'chg_1',
      byAgentPages: ['household/lease'],
    })!;
    expect(note.match(/household\/lease/g)).toHaveLength(1);
    expect(note).not.toContain('Also saved');
  });

  it('says "Remembered" when only the digest wrote', () => {
    const note = describeDigest({
      wrote: [{ slug: 'household/lease' }],
      held: [],
      changeId: 'chg_1',
    })!;
    expect(note).toContain('Remembered');
    expect(note).not.toContain('Saved to memory');
  });
});

/**
 * **The turn, not half of it.**
 *
 * The digest was fed the user's raw text and nothing else, captured at routing time — before a
 * reply exists. On a turn where the user asks and the assistant goes and finds out, everything
 * worth keeping is in the answer, and the extractor was shown only the question. It concluded
 * there was nothing to keep, which was true of what it saw.
 */
describe('what the digest is shown', () => {
  function sessionDb(name: string) {
    const dbPath = path.join(TEST_DIR, `${name}.db`);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    return openSessionDb(dbPath);
  }

  beforeEach(() => {
    lastRetain = null;
    resetAgentWritesForTesting();
  });

  const retainedItems = () => lastRetain!.sources[0]!.input.items;
  const retainMission = () => lastRetain!.sources[0]!.retention.mission ?? '';

  it('hands over the assistant’s answer, not only the question', async () => {
    const db = sessionDb('reply');
    try {
      notePendingDigest(db, {
        text: 'How much can Vulpine Mutual raise the premium?',
        at: Date.now(),
      });
      noteReply(db, 'Vulpine Mutual caps the annual premium increase at 5% this year.');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r1' });

      expect(retainedItems().map((item) => item.text)).toEqual(
        expect.arrayContaining([
          'How much can Vulpine Mutual raise the premium?',
          'Vulpine Mutual caps the annual premium increase at 5% this year.',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('gives the two halves distinct source roles', async () => {
    // Retain carries attribution structurally, so the extractor need not infer it from labels
    // embedded in a prose blob.
    const db = sessionDb('labels');
    try {
      notePendingDigest(db, { text: 'What is the cap?', at: Date.now() });
      noteReply(db, 'It is 5% this year.');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r2' });

      expect(retainedItems().map((item) => item.role)).toEqual(['user', 'assistant']);
      expect(retainMission()).toMatch(/finding/i);
    } finally {
      db.close();
    }
  });

  it('hands ordinary report dates and estimates to retention with history admission and the original source clock', async () => {
    const db = sessionDb('dated-report');
    const at = Date.parse('2031-04-04T09:00:00Z');
    const report =
      'Luna reports that Vulpine Mutual confirmed Ada Marlow’s Zephyr QX-100 order. ' +
      'The device is estimated for 13–15 April 2031; the accessory for 6 April 2031.';
    try {
      notePendingDigest(db, { text: 'Review the daily report again.', at, role: 'user', speaker: 'Ada Marlow' });
      notePendingDigestReply(db, { itemId: 'dated-report-reply', text: report, at: at + 1_000 });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'dated-report' });

      expect(retainedItems()).toEqual([
        expect.objectContaining({ role: 'user', speaker: 'Ada Marlow', mentioned_at: '2031-04-04T09:00:00.000Z' }),
        expect.objectContaining({
          role: 'assistant',
          speaker: 'Luna',
          text: report,
          mentioned_at: '2031-04-04T09:00:01.000Z',
        }),
      ]);
      expect(lastRetain!.sources[0]?.mentioned_at).toBe('2031-04-04T09:00:01.000Z');
      expect(retainMission()).toMatch(/dated.*history|history.*date/s);
      expect(retainMission()).not.toContain('anything that expires on its own');
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('sends a plain message as one user item', async () => {
    const db = sessionDb('plain');
    try {
      notePendingDigest(db, { text: 'The rent goes up to 1250 in September.', at: Date.now() });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r3' });

      expect(retainedItems()).toMatchObject([{ text: 'The rent goes up to 1250 in September.', role: 'user' }]);
    } finally {
      db.close();
    }
  });

  it('includes the message being replied to, as content rather than as instruction', async () => {
    // It used to be quoted into the mission, which is emphasis appended to a system prompt —
    // asking the model to read somebody else's words as something it was told to do.
    const db = sessionDb('quoted');
    try {
      notePendingDigest(db, {
        text: 'Yes, book it.',
        replyTo: 'The Blackwater Bay ferries are 40 EUR return on the 9th.',
        at: Date.now(),
      });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r4' });

      expect(retainedItems()).toMatchObject([
        { text: 'The Blackwater Bay ferries are 40 EUR return on the 9th.', role: 'external' },
        { text: 'Yes, book it.', role: 'user' },
      ]);
      expect(retainMission()).not.toContain('240 EUR return');
    } finally {
      db.close();
    }
  });

  it('strips reasoning the reader never saw', async () => {
    const db = sessionDb('internal');
    try {
      notePendingDigest(db, { text: 'What is the cap?', at: Date.now() });
      noteReply(db, '<internal>let me check the policy</internal>It is 5% this year.');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r5' });

      const texts = retainedItems()
        .map((item) => item.text)
        .join('\n');
      expect(texts).not.toContain('let me check');
      expect(texts).toContain('5%');
    } finally {
      db.close();
    }
  });

  it('ignores a reply with no question behind it', async () => {
    // A scheduled task's report or a proactive note. Nobody asked, so there is no turn for it to
    // be the answer to — and queueing it would attach it to whatever the user says next.
    const db = sessionDb('unprompted');
    try {
      noteReply(db, 'Your morning brief: three meetings today.');
      expect(getSessionState(db, 'memory:pending-reply')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('runs even when the agent already wrote, and says what it must not restate', async () => {
    // Standing down entirely was too blunt. The agent records the one fact it was asked about
    // and moves on; on a research turn a single `memory_write` discarded everything else the
    // turn produced.
    const db = sessionDb('also-wrote');
    try {
      notePendingDigest(db, { text: 'What is the cap?', at: Date.now() - 1000 });
      noteReply(db, 'It is 5% this year.');
      // As the container records it: no `source: 'digest'`, which is what marks a write as the
      // agent's own.
      setSessionState(
        db,
        'memory:changes',
        JSON.stringify([{ kind: 'page', slug: 'household/lease', at: new Date().toISOString() }]),
      );
      noteAgentMemoryWriteFromTool('r6', 'memory_write');

      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6' });

      expect(lastRetain, 'the digest stood down instead of running').not.toBeNull();
      expect(retainMission()).toContain('household/lease');
      expect(retainMission()).toMatch(/do not restate/i);
    } finally {
      db.close();
    }
  });

  it('names the pages a slug-less `remember` wrote, which the journal cannot see', async () => {
    // The container journals the `slug` a call named. `memory_remember` has none — memory decides
    // where each claim goes — so the journal stayed empty and the mission never named the page the
    // agent had just created. This invented product review reproduces the duplicate extraction.
    // The destination is only in the *result*, so the memory builtin
    // reports it here.
    const db = sessionDb('remember-wrote');
    try {
      notePendingDigest(db, { text: 'Make a product review.', at: Date.now() - 1000 });
      noteReply(db, 'Recommended with caveats. The warranty is three years.');
      // No `memory:changes` entry at all — that is the state the bug left behind.
      noteAgentMemoryWriteFromTool('r6b', 'memory_remember');
      noteAgentMemoryPages('r6b', ['shopping/vulpine-sofa', 'timeline']);

      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6b' });

      expect(retainMission()).toContain('shopping/vulpine-sofa');
      expect(retainMission()).toMatch(/do not restate/i);
      // Named as a destination, not only as text to skip: a page written minutes ago is the one
      // routing is least able to score, having the least text to match against.
      expect(retainMission()).toMatch(/put it there rather than on a new page/i);
    } finally {
      db.close();
    }
  });

  it('does not report a previous topic’s conversation mirror as a write from the new turn', async () => {
    retainResult = {
      outcome: 'held',
      status: 'ok',
      candidates: [
        {
          candidate_id: 'held-1',
          outcome: 'held',
          reason_code: 'discourse_uncertain',
          reason: 'the retained representation was not confirmed',
        },
      ],
    };
    const db = sessionDb('episode-mirror');
    const sessionId = 'episode-mirror';
    const mirrorSlug = 'conversations/2031-05-03-garden-visit';
    try {
      notePendingDigest(db, { text: 'Please remember the warranty reference.', at: Date.now() - 1000 });
      // A topic change closes the earlier episode. Its background mirror writes during this turn,
      // through the same memory tool as an intentional foreground save.
      noteAgentMemoryPages(sessionId, [mirrorSlug]);
      setSessionState(
        db,
        'memory:changes',
        JSON.stringify([{ kind: 'page', slug: mirrorSlug, at: new Date().toISOString() }]),
      );
      noteAgentMemoryWriteFromTool(sessionId, 'memory_write');

      const outcome = await runPendingDigest(db, { agentGroupId: 'ag', sessionId });
      expect(outcome?.byAgentPages).toEqual([]);
      expect(retainMission()).not.toContain(mirrorSlug);
      const note = describeDigest(outcome!)!;
      expect(note).toContain('1 item(s) were not retained safely');
      expect(note).not.toContain('Saved to memory');
      expect(note).not.toContain(mirrorSlug);
    } finally {
      db.close();
    }
  });

  it('does not carry one turn’s written pages into the next', async () => {
    // The map is per-process and nothing else empties it, so the digest consumes it. Left to
    // accumulate it would name last turn's pages as this turn's — and the mission now points the
    // extractor at them, so a stale name misdirects rather than merely misinforms.
    const db = sessionDb('not-carried');
    try {
      notePendingDigest(db, { text: 'first', at: Date.now() - 1000 });
      noteAgentMemoryWriteFromTool('r6c', 'memory_remember');
      noteAgentMemoryPages('r6c', ['shopping/vulpine-sofa']);
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6c' });
      expect(retainMission()).toContain('shopping/vulpine-sofa');

      notePendingDigest(db, { text: 'second, about something else', at: Date.now() });
      noteAgentMemoryWriteFromTool('r6c', 'memory_write');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6c' });
      expect(retainMission()).not.toContain('shopping/vulpine-sofa');
    } finally {
      db.close();
    }
  });

  it('drops written pages the staleness check rejected, instead of holding them', async () => {
    // The set is consumed before the check, not inside it. Held on the branch that does not use it, a
    // page written long ago waits for the next turn whose only memory call is a `forget` — that bumps
    // the write stamp, passes the check, and the mission announces a three-turn-old page as
    // "already recorded during this turn".
    const db = sessionDb('stale-not-held');
    try {
      // Written before anything this digest is about, so the staleness check rejects it.
      noteAgentMemoryPages('r6d', ['wiki/from-an-old-turn']);
      noteAgentMemoryWriteFromTool('r6d', 'memory_remember');
      const later = Date.now() + 60_000;
      notePendingDigest(db, { text: 'something new', at: later });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6d' });
      expect(retainMission()).not.toContain('wiki/from-an-old-turn');

      // The next turn does write, so the check passes — and the old page must not reappear with it.
      notePendingDigest(db, { text: 'and another', at: Date.now() });
      noteAgentMemoryWriteFromTool('r6d', 'memory_forget');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r6d' });
      expect(retainMission()).not.toContain('wiki/from-an-old-turn');
    } finally {
      db.close();
    }
  });

  it('consumes the reply with the question, so it never outlives it', async () => {
    const db = sessionDb('consumed');
    try {
      notePendingDigest(db, { text: 'What is the cap?', at: Date.now() });
      noteReply(db, 'It is 5% this year.');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r7' });

      expect(getSessionState(db, 'memory:pending')).toBeNull();
      expect(getSessionState(db, 'memory:pending-reply')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps the reply when memory could not be reached', async () => {
    // The exact structured source is kept on an unreachable service. Reconstructing it later from
    // half a queue would lose the answer or change the revision.
    const db = sessionDb('outage-reply');
    try {
      notePendingDigest(db, { text: 'What is the cap?', at: Date.now() });
      noteReply(db, 'It is 5% this year.');
      memoryFailure = new MemoryUnavailable('no memory service');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'r8' });

      const inflight = getSessionState(db, 'memory:retain-inflight');
      expect(inflight).not.toBeNull();
      expect(inflight).toContain('It is 5% this year.');
    } finally {
      db.close();
    }
  });
});

describe('a memory that went away mid-conversation', () => {
  /**
   * What actually happened. The memory service restarted, and every host call afterwards failed
   * with "the connection is closed" — which the connection-loss check did not match, so the dead
   * handle was never dropped and every later call failed the same way. The digest clears its queue
   * before calling, so each failure lost the message outright: two conversations digested into
   * nothing, ten minutes apart, with the agent having said "I'll remember that".
   */
  function sessionDb(name: string) {
    const dbPath = path.join(TEST_DIR, `${name}.db`);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(dbPath);
    return openSessionDb(dbPath);
  }

  it('seals stable provenance into a keyed conversation revision', async () => {
    const db = sessionDb('retain-source');
    const at = Date.parse('2026-08-18T10:15:00.000Z');
    try {
      notePendingDigest(db, {
        itemId: 'telegram:message-42',
        text: 'I selected the five-year warranty.',
        speaker: 'Ada Marlow',
        at,
      });
      notePendingDigestReply(db, {
        itemId: 'out-42',
        text: 'The warranty covers parts and labour.',
        at: at + 1_000,
      });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'stable-source' });

      const source = lastRetain!.sources[0]!;
      expect(source.source_id).toMatch(/^luna:[a-f0-9]{8}:conversation:ag:stable-source$/);
      expect(source.source_group).toBe(source.source_id);
      expect(source.source_kind).toBe('conversation');
      expect(source.revision).toMatch(/^digest-[a-f0-9]{40}$/);
      expect(source.locator).toMatch(new RegExp(`^${source.source_id}#[a-f0-9]{40}$`));
      expect(source.timezone).toBeTruthy();
      expect(source.input.items).toMatchObject([
        {
          item_id: 'telegram:message-42',
          role: 'user',
          speaker: 'Ada Marlow',
          mentioned_at: '2026-08-18T10:15:00.000Z',
        },
        {
          item_id: 'out-42',
          role: 'assistant',
          speaker: 'Luna',
          mentioned_at: '2026-08-18T10:15:01.000Z',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('attributes a forward to its original speaker structurally', async () => {
    const db = sessionDb('forward-source');
    try {
      notePendingDigest(db, {
        itemId: 'forward-1',
        text: 'My membership number is 88-4120.',
        speaker: 'Ada Marlow',
        forwardedFrom: 'Brannoch',
        at: Date.now(),
      });
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'forward-source' });

      expect(lastRetain!.sources[0]!.input.items).toMatchObject([
        { item_id: 'forward-1', role: 'external', speaker: 'Brannoch' },
      ]);
    } finally {
      db.close();
    }
  });

  it('filters damaged persisted rows and repairs an empty legacy item id', async () => {
    const db = sessionDb('damaged-pending');
    try {
      const at = Date.now();
      setSessionState(
        db,
        'memory:pending',
        JSON.stringify([
          { itemId: '', text: 'A valid legacy message.', at },
          { itemId: 'bad-role', text: 'Do not send this.', role: 'system', at },
          { itemId: 'bad-time', text: 'Nor this.', at: Number.NaN },
        ]),
      );

      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'damaged-pending' });

      const items = lastRetain!.sources[0]!.input.items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ text: 'A valid legacy message.', role: 'user' });
      expect(items[0]!.item_id).toMatch(/^legacy:/);
    } finally {
      db.close();
    }
  });

  it('retries the exact sealed request while new messages wait in the next batch', async () => {
    const db = sessionDb('exact-replay');
    try {
      notePendingDigest(db, { itemId: 'in-old', text: 'The old turn.', at: Date.now() });
      memoryFailure = new MemoryUnavailable('socket dropped after send');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'exact-replay' });

      const sealed = JSON.parse(getSessionState(db, 'memory:retain-inflight')!) as {
        source: CapturedRetainSource;
      };
      notePendingDigest(db, { itemId: 'in-new', text: 'The next turn.', at: Date.now() + 1 });

      memoryFailure = null;
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'exact-replay' });
      expect(lastRetain!.sources[0]).toEqual(sealed.source);
      expect(getSessionState(db, 'memory:pending')).toContain('The next turn.');

      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 'exact-replay' });
      expect(lastRetain!.sources[0]!.input.items.map((item) => item.item_id)).toEqual(['in-new']);
    } finally {
      db.close();
    }
  });

  it('keeps the message when memory could not be reached', async () => {
    const db = sessionDb('outage');
    try {
      notePendingDigest(db, { text: 'We watched Harbour Lights and rated it 8/10.', at: Date.now() });
      memoryFailure = new MemoryUnavailable('no memory service at /tmp/x.sock');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 's1' });

      const queued = JSON.parse(getSessionState(db, 'memory:retain-inflight') ?? '{}') as { attempts?: number };
      expect(queued.attempts).toBe(1);
    } finally {
      db.close();
    }
  });

  it('holds the conversation across an outage longer than a memory deploy', async () => {
    // The bound that mattered: a service being upgraded is unreachable for minutes, and the
    // conversation has to still be there when it comes back. Three sweeps was not enough and
    // six conversations were lost to it.
    const db = sessionDb('deploy-window');
    try {
      notePendingDigest(db, { text: 'Something worth keeping.', at: Date.now() });
      memoryFailure = new MemoryUnavailable('still down');
      for (let sweep = 0; sweep < 30; sweep++) {
        await runPendingDigest(db, { agentGroupId: 'ag', sessionId: `s2-${sweep}` });
      }

      const queued = JSON.parse(getSessionState(db, 'memory:retain-inflight') ?? '{}') as { attempts?: number };
      expect(queued.attempts).toBe(30);
    } finally {
      db.close();
    }
  });

  it('gives up eventually rather than retrying forever', async () => {
    // The reason the queue is cleared first still holds: a failure that keeps failing must not
    // re-run model work on every sweep for the life of the session.
    const db = sessionDb('give-up');
    try {
      notePendingDigest(db, { text: 'Something worth keeping.', at: Date.now() });
      memoryFailure = new MemoryUnavailable('still down');
      for (let sweep = 0; sweep < 61; sweep++) {
        await runPendingDigest(db, { agentGroupId: 'ag', sessionId: `s2-${sweep}` });
      }
      expect(getSessionState(db, 'memory:pending')).toBeNull();
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('drops the message when memory answered and the work failed', async () => {
    // A programming or validation error cannot be repaired by replay and must not wedge the queue.
    const db = sessionDb('answered');
    try {
      notePendingDigest(db, { text: 'Something worth keeping.', at: Date.now() });
      memoryFailure = new Error('the deriver returned unusable JSON');
      await runPendingDigest(db, { agentGroupId: 'ag', sessionId: 's3' });
      expect(getSessionState(db, 'memory:pending')).toBeNull();
      expect(getSessionState(db, 'memory:retain-inflight')).toBeNull();
    } finally {
      db.close();
    }
  });
});
