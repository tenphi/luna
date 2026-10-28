import fs from 'fs';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/paths.js', () => ({
  configDir: () => '/tmp/luna-test-memcmd/config',
  defaultConfigPath: () => '/tmp/luna-test-memcmd/config/default.jsonc',
  localConfigPath: () => '/tmp/luna-test-memcmd/config/local.jsonc',
}));

const calls: { op: string; input: unknown }[] = [];
let reply: unknown = {};
let fail: Error | null = null;

vi.mock('../session-manager.js', () => ({
  sessionDir: (agentGroupId: string, sessionId: string) =>
    `/tmp/luna-test-memcmd/sessions/${agentGroupId}/${sessionId}`,
}));

const aknoPath = '/tmp/luna-test-memcmd/brain';

vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js');
  const run = async (work: (client: unknown) => Promise<unknown>) => {
    if (fail) throw fail;
    return work({
      call: async (op: string, input: unknown) => {
        calls.push({ op, input });
        return reply;
      },
      command: async (op: string, input: unknown) => {
        calls.push({ op, input });
        return reply;
      },
    });
  };
  return {
    ...actual,
    withMemory: run,
    retryRead: run,
    memory: async () => {
      if (fail) throw fail;
      return { hello: { akno_path: aknoPath } };
    },
  };
});

import { MemoryUnavailable } from './client.js';
import { MEMORY_COMMANDS, runMemoryCommand } from './commands.js';

beforeEach(() => {
  calls.length = 0;
  reply = {};
  fail = null;
});
afterEach(() => vi.restoreAllMocks());

/**
 * Looking at memory, and correcting it, without the agent in the way.
 *
 * Every one of these ran inside the container until now, against a knowledge base it had mounted
 * and a binary on its PATH — neither of which exists any more, so all of them answered "not
 * available". What is asserted here is the part a user actually depends on: that a wrong sentence
 * can be found and then removed, and that an outage never reads as an empty memory.
 */
describe('memory slash commands', () => {
  it('discovers empty timeline declarations with their write policy and partial status', async () => {
    reply = {
      status: 'degraded',
      total: 2,
      timelines: [
        { slug: 'work/timeline', title: 'Work', description: 'Prototype milestones', status: 'ready', writable: true },
        {
          slug: 'case/timeline',
          title: 'Case',
          description: '',
          status: 'quarantined',
          writable: false,
          note: 'Unavailable declaration',
        },
      ],
    };
    const out = await runMemoryCommand('/timelines', '');
    expect(calls).toEqual([{ op: 'list', input: { kind: 'timelines' } }]);
    expect(out).toContain('Prototype milestones');
    expect(out).toContain('quarantined, not writable');
    expect(out).toContain('missing timelines do not prove absence');
  });

  it('reads bounded combined history without flattening plans and document evidence', async () => {
    reply = {
      status: 'ok',
      selected_timelines: ['work/timeline', 'case/timeline'],
      total: 2,
      results: [
        {
          type: 'memory',
          start: '2031-04-05',
          summary: 'Inspect the prototype.',
          slug: 'work/prototype',
          line: 12,
          source_kind: 'plan',
          temporal_status: 'tentative',
          disposition: 'proposed',
          clock_relation: 'future',
          timeline: 'work/timeline',
          timeline_basis: 'source_page',
        },
        {
          type: 'document_evidence',
          start: '2031-04-06',
          label: 'Fictional notice',
          path: 'case/notice.pdf',
          date_basis: 'file_modified',
          source_kind: 'document_evidence',
          temporal_status: 'evidence',
          clock_relation: 'future',
          availability: 'available',
          timeline: 'case/timeline',
          timeline_basis: 'document_path',
        },
      ],
    };
    const out = await runMemoryCommand('/timeline', '* 2031-04 2031-05');
    expect(calls).toEqual([
      { op: 'timeline', input: { timeline: '*', since: '2031-04', until: '2031-05', limit: 20 } },
    ]);
    expect(out).toContain('plan, tentative, proposed');
    expect(out).toContain('`work/prototype`:12');
    expect(out).toContain('timeline `work/timeline` (source_page)');
    expect(out).toContain('file_modified');
    expect(out).toContain('document_evidence, evidence');
    expect(out).toContain('timeline `case/timeline` (document_path)');
  });

  it.each(['degraded', 'unavailable'])('does not report incomplete history as empty (%s)', async (status) => {
    reply = { status, results: [], total: 0 };
    const out = await runMemoryCommand('/timeline', 'work/timeline');
    expect(out).toContain('History is incomplete');
    expect(out).not.toContain('No entries');
  });

  it('requires a manual timeline selection and rejects malformed dates without calling memory', async () => {
    for (const input of ['', 'work/timeline tomorrow', 'work/timeline 2031 2032 extra'])
      expect(await runMemoryCommand('/timeline', input)).toContain('Usage:');
    expect(calls).toEqual([]);
  });

  it('claims exactly the commands the router hands over', () => {
    expect([...MEMORY_COMMANDS].sort()).toEqual([
      '/delete',
      '/download',
      '/forget',
      '/list',
      '/raw',
      '/read',
      '/recall',
      '/restore',
      '/timeline',
      '/timelines',
      '/undo',
    ]);
  });

  describe('/recall', () => {
    it('prints the id beside the sentence it belongs to', async () => {
      // The whole point of showing lines rather than summaries: /forget takes one of these. A search
      // that shows a wrong sentence without the handle to remove it is a dead end.
      reply = {
        status: 'ok',
        results: [
          {
            type: 'page',
            slug: 'household/lease',
            summary: null,
            lines: [
              { n: 12, text: 'The rent is 1200 EUR per month.', fact: 'fct_rent' },
              { n: 13, text: 'The landlord is Bo Winters.' },
            ],
          },
        ],
      };
      const out = await runMemoryCommand('/recall', 'rent');
      expect(out).toContain('household/lease');
      expect(out).toContain('The rent is 1200 EUR per month.');
      expect(out).toContain('fct_rent');
      expect(out).toContain('/forget <id>');
      expect(calls[0]).toEqual({ op: 'recall', input: { query: 'rent' } });
    });

    it('does not offer a retraction when nothing is retractable', async () => {
      reply = {
        status: 'ok',
        results: [{ type: 'page', slug: 'notes/x', summary: null, lines: [{ n: 1, text: 'Plain prose.' }] }],
      };
      expect(await runMemoryCommand('/recall', 'x')).not.toContain('/forget');
    });

    it('distinguishes a protocol-v3 observation from an authored fact', async () => {
      reply = {
        status: 'ok',
        results: [
          {
            type: 'page',
            slug: 'people/ada-marlow',
            summary: null,
            lines: [
              {
                n: 18,
                text: 'Observation: Ada tends to schedule focused work in the morning.',
                observation: {
                  status: 'eligible',
                  id: 'obs_focus',
                  level: 2,
                  subject: 'people/ada-marlow',
                  disposition: 'active',
                  proof_count: 2,
                  evidence: [
                    {
                      fact: 'fct_1',
                      slug: 'people/ada-marlow',
                      line: 7,
                      line_hash: 'hash_1',
                      proof_groups: ['people/ada-marlow:7'],
                    },
                    {
                      fact: 'fct_2',
                      slug: 'work/planning',
                      line: 12,
                      line_hash: 'hash_2',
                      proof_groups: ['work/planning:12'],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const out = await runMemoryCommand('/recall', 'Ada work pattern');
      expect(out).toContain('Observation: Ada tends to schedule focused work in the morning.');
      expect(out).toContain('derived observation, 2 independent proofs');
      expect(out).toContain('`people/ada-marlow:7`');
      expect(out).toContain('`work/planning:12`');
      expect(out).not.toContain('/forget');
    });

    it('does not surface an ineligible observation as recall evidence', async () => {
      reply = {
        status: 'ok',
        results: [
          {
            type: 'page',
            slug: 'people/ada-marlow',
            summary: 'Ada always works best in the morning.',
            lines: [
              {
                n: 18,
                text: 'A stale observation.',
                observation: {
                  status: 'ineligible',
                  id: 'obs_stale',
                  level: 2,
                  disposition: 'retracted',
                  reason: 'support changed',
                },
              },
            ],
          },
        ],
      };

      const out = await runMemoryCommand('/recall', 'Ada work pattern');
      expect(out).not.toContain('A stale observation.');
      expect(out).not.toContain('Ada always works best in the morning.');
    });

    it('labels a retained plan with its source and non-factual eligibility', async () => {
      reply = {
        status: 'ok',
        memory_view: 'planning',
        results: [
          {
            type: 'page',
            slug: 'projects/zephyr-qx-100',
            summary: null,
            lines: [
              {
                n: 9,
                text: 'Bo Winters proposed a launch at Blackwater Bay.',
                memory: {
                  status: 'qualified',
                  id: 'mem_launch',
                  level: 1,
                  kind: 'plan',
                  subject: 'projects/zephyr-qx-100',
                  source_role: 'external',
                  source_speaker: 'Bo Winters',
                  commitment: 'tentative',
                  disposition: 'proposed',
                  polarity: 'affirmed',
                  basis: 'source_report',
                  answer_eligible: false,
                  current_eligible: true,
                },
              },
            ],
          },
        ],
      };

      const out = await runMemoryCommand('/recall', 'Zephyr QX-100 launch plans');
      expect(out).toContain('Bo Winters proposed a launch at Blackwater Bay.');
      expect(out).toContain('retained plan');
      expect(out).toContain('source report');
      expect(out).toContain('source external: Bo Winters');
      expect(out).toContain('context for planning, not an ordinary fact');
      expect(out).toContain('mem_launch');
      expect(out).toContain('/forget <id>');
    });

    it('does not surface unavailable or non-factual retained memory in a factual result', async () => {
      reply = {
        status: 'ok',
        memory_view: 'factual',
        results: [
          {
            type: 'page',
            slug: 'projects/zephyr-qx-100',
            summary: 'The Zephyr QX-100 launch is confirmed.',
            lines: [
              {
                n: 4,
                text: 'Unavailable retained memory.',
                memory: { status: 'unavailable', id: 'mem_unavailable', answer_eligible: false },
              },
              {
                n: 5,
                text: 'A report that is not ordinary factual evidence.',
                memory: {
                  status: 'qualified',
                  id: 'mem_report',
                  level: 1,
                  kind: 'claim',
                  subject: 'projects/zephyr-qx-100',
                  source_role: 'external',
                  commitment: 'asserted',
                  disposition: 'active',
                  polarity: 'affirmed',
                  basis: 'source_report',
                  answer_eligible: false,
                  current_eligible: true,
                },
              },
              {
                n: 6,
                text: 'Malformed retained memory.',
                memory: { status: 'qualified', id: 'mem_broken', level: 1 },
              },
            ],
          },
        ],
      };

      const out = await runMemoryCommand('/recall', 'Is the Zephyr QX-100 launch confirmed?');
      expect(out).not.toContain('Unavailable retained memory.');
      expect(out).not.toContain('A report that is not ordinary factual evidence.');
      expect(out).not.toContain('Malformed retained memory.');
      expect(out).not.toContain('The Zephyr QX-100 launch is confirmed.');
    });

    it('says a degraded search proves nothing', async () => {
      // "Nothing in memory about X" after half the search failed is a confident lie about the
      // user's own history.
      reply = { status: 'degraded', results: [] };
      const out = await runMemoryCommand('/recall', 'wife');
      expect(out).toMatch(/does not mean it is not there/i);
    });
  });

  describe('/forget', () => {
    it('retracts a sentence when given a fact id', async () => {
      reply = {
        status: 'ok',
        change_id: 'chg_9',
        removed: 'The rent is 1200 EUR.',
        removed_from: 'household/lease:12',
      };
      const out = await runMemoryCommand('/forget', 'fct_rent');
      expect(calls[0]).toEqual({ op: 'forget', input: { fact: 'fct_rent' } });
      expect(out).toContain('The rent is 1200 EUR.');
      expect(out).toContain('/undo chg_9');
    });

    it('removes a complete managed-memory block by its memory id', async () => {
      reply = {
        status: 'ok',
        change_id: 'chg_11',
        removed_from: 'projects/zephyr-qx-100:9',
        removed:
          '<!-- akno:item mem_launch v=2 kind=plan subject=projects/zephyr-qx-100 -->\n' +
          '- Bo Winters proposed a launch at Blackwater Bay.',
      };

      const out = await runMemoryCommand('/forget', 'mem_launch');
      expect(calls[0]).toEqual({ op: 'forget', input: { memory: 'mem_launch' } });
      expect(out).toContain('Bo Winters proposed a launch at Blackwater Bay.');
      expect(out).not.toContain('<!-- akno:item');
      expect(out).toContain('/undo chg_11');
    });

    it('finds the sentence when given words instead of an id', async () => {
      // Nobody knows a fact id off the top of their head; they know the sentence that is wrong.
      // Telling them to run /recall first and copy an id out is a dead end for anyone who does not
      // already know the command exists.
      reply = {
        results: [
          {
            type: 'page',
            slug: 'household/lease',
            lines: [
              { n: 12, text: 'The rent is 1200 EUR per month.', fact: 'fct_rent' },
              { n: 13, text: 'No fact on this line.' },
            ],
          },
        ],
      };
      const out = await runMemoryCommand('/forget', 'the rent is 1200');
      expect(calls[0]).toEqual({ op: 'recall', input: { query: 'the rent is 1200', memory_view: 'all' } });
      expect(out).toContain('fct_rent');
      expect(out).toContain('household/lease');
      expect(out).toContain('/forget <id>');
    });

    it('finds a non-factual retained item by text and offers its memory id', async () => {
      reply = {
        status: 'ok',
        memory_view: 'all',
        results: [
          {
            type: 'page',
            slug: 'projects/zephyr-qx-100',
            lines: [
              {
                n: 9,
                text: 'Bo Winters proposed a launch at Blackwater Bay.',
                memory: {
                  status: 'qualified',
                  id: 'mem_launch',
                  level: 1,
                  kind: 'plan',
                  subject: 'projects/zephyr-qx-100',
                  source_role: 'external',
                  source_speaker: 'Bo Winters',
                  commitment: 'tentative',
                  disposition: 'proposed',
                  polarity: 'affirmed',
                  basis: 'source_report',
                  answer_eligible: false,
                  current_eligible: true,
                },
              },
            ],
          },
        ],
      };

      const out = await runMemoryCommand('/forget', 'launch at Blackwater Bay');
      expect(calls[0]).toEqual({
        op: 'recall',
        input: { query: 'launch at Blackwater Bay', memory_view: 'all' },
      });
      expect(out).toContain('mem_launch');
      expect(out).toContain('Bo Winters proposed a launch at Blackwater Bay.');
      expect(calls.map((call) => call.op)).toEqual(['recall']);
    });

    it('never retracts on a search alone', async () => {
      // A search confident enough to delete a sentence unseen will eventually delete the wrong one.
      reply = {
        results: [{ type: 'page', slug: 'x', lines: [{ n: 1, text: 'One match only.', fact: 'fct_only' }] }],
      };
      await runMemoryCommand('/forget', 'one match');
      expect(calls.map((call) => call.op)).toEqual(['recall']);
    });

    it('points a page slug at /delete when nothing retractable matches', async () => {
      reply = { results: [] };
      const out = await runMemoryCommand('/forget', 'people/jane');
      expect(out).toContain('/delete people/jane');
    });

    it('says what to type rather than guessing', async () => {
      const out = await runMemoryCommand('/forget', '');
      expect(out).toContain('/forget <what is wrong>');
      expect(calls).toHaveLength(0);
    });
  });

  describe('/undo', () => {
    it('reverses the most recent change when given no id', async () => {
      // "That was wrong" should not require copying an id out of an earlier message.
      reply = [
        { id: 'chg_new', summary: 'wrote household/lease', status: 'applied' },
        { id: 'chg_old', summary: 'wrote people/jane', status: 'applied' },
      ];
      const out = await runMemoryCommand('/undo', '');
      expect(calls[0]!.op).toBe('changes');
      expect(calls[1]).toEqual({ op: 'undo', input: { change_id: 'chg_new' } });
      expect(out).toContain('Undone');
    });

    it('skips a change that was already undone', async () => {
      reply = [{ id: 'chg_done', summary: 'x', status: 'undone' }];
      expect(await runMemoryCommand('/undo', '')).toContain('Nothing to undo');
    });

    it('takes a named id, which outlives the conversation', async () => {
      reply = { reversed: 'removed household/lease:12' };
      await runMemoryCommand('/undo', 'chg_abc');
      expect(calls[0]).toEqual({ op: 'undo', input: { change_id: 'chg_abc' } });
    });
  });

  describe('/read and /list', () => {
    it('reads a page body back', async () => {
      reply = { page: { slug: 'people/jane', title: 'Jane', summary: null, lines: [{ n: 1, text: 'A vet.' }] } };
      const out = await runMemoryCommand('/read', 'people/jane');
      expect(out).toContain('people/jane');
      expect(out).toContain('A vet.');
    });

    it('does not show the reader the page’s filing metadata', async () => {
      // `read` returns the file, frontmatter included. Six lines of `type:` and `created_at:`
      // before the first sentence is most of a phone screen.
      reply = {
        page: {
          slug: 'research/x',
          title: 'X',
          summary: null,
          lines: [
            { n: 1, text: '---' },
            { n: 2, text: 'type: note' },
            { n: 3, text: '---' },
            { n: 4, text: 'The actual content.' },
          ],
        },
      };
      const out = await runMemoryCommand('/read', 'research/x');
      expect(out).toContain('The actual content.');
      expect(out).not.toContain('type: note');
    });

    it('keeps the page when a stray rule looks like an unterminated block', async () => {
      reply = {
        page: {
          slug: 'notes/y',
          title: 'Y',
          summary: null,
          lines: [
            { n: 1, text: '---' },
            { n: 2, text: 'Everything below this.' },
          ],
        },
      };
      expect(await runMemoryCommand('/read', 'notes/y')).toContain('Everything below this.');
    });

    it('points at the ways to find a page it could not open', async () => {
      reply = {};
      const out = await runMemoryCommand('/read', 'people/nobody');
      expect(out).toContain('/list people');
      expect(out).toContain('/recall nobody');
    });

    it('lists folders with the command that opens them', async () => {
      reply = { folders: [{ path: 'household', pages: 2, pages_deep: 9 }], pages: [] };
      const out = await runMemoryCommand('/list', '');
      expect(out).toContain('household');
      expect(out).toContain('/list household');
    });
  });

  describe('/raw', () => {
    it('keeps the frontmatter /read drops', async () => {
      // The reason to ask for raw is to see the file — its tags, its wikilinks unrendered — which is
      // exactly what /read removes.
      reply = {
        page: {
          slug: 'notes/x',
          title: 'X',
          summary: null,
          lines: [
            { n: 1, text: '---' },
            { n: 2, text: 'type: note' },
            { n: 3, text: '---' },
            { n: 4, text: 'Body [[wiki]] link.' },
          ],
        },
      };
      const raw = await runMemoryCommand('/raw', 'notes/x');
      expect(raw).toContain('type: note');
      expect(raw).toContain('[[wiki]]');
      // Fenced, or the client renders the very markdown that was asked for verbatim.
      expect(raw).toContain('```markdown');

      const read = await runMemoryCommand('/read', 'notes/x');
      expect(read).not.toContain('type: note');
    });
  });

  describe('/delete', () => {
    it('sends a page to trash and names both ways back', async () => {
      // `trashed` is the absolute path of the snapshot inside memory's trash directory. Quoting it
      // back produced `/restore /Users/…/.akno/trash/trash_238e8795/people/jane.md` — a command
      // naming a file that cannot be looked up and that the user cannot have meant.
      reply = { change_id: 'chg_5', trashed: '/Users/x/.akno/trash/trash_9/people/jane.md' };
      const out = await runMemoryCommand('/delete', 'people/jane');
      expect(calls[0]).toEqual({ op: 'forget', input: { slug: 'people/jane' } });
      expect(out).toContain('/restore people/jane');
      expect(out).not.toContain('.akno/trash');
      expect(out).toContain('/undo chg_5');
    });

    it('refuses a fact id rather than reading it as a page', async () => {
      const out = await runMemoryCommand('/delete', 'fct_abc');
      expect(calls).toHaveLength(0);
      expect(out).toContain('/forget fct_abc');
    });
  });

  describe('/restore', () => {
    const deleted = [
      {
        id: 'chg_w',
        at: '2026-08-07T10:00:00Z',
        summary: 'wrote people/bran',
        status: 'applied',
        files: [{ relPath: 'people/bran.md', action: 'modified' }],
      },
      {
        id: 'chg_d',
        at: '2026-08-05T09:00:00Z',
        summary: 'deleted people/jane',
        status: 'applied',
        files: [{ relPath: 'people/jane.md', action: 'deleted' }],
      },
    ];

    it('lists what was deleted, ignoring everything else that happened', async () => {
      reply = deleted;
      const out = await runMemoryCommand('/restore', '');
      expect(out).toContain('people/jane');
      expect(out).not.toContain('people/bran');
      expect(out).toContain('2026-08-05');
    });

    it('reverses that page’s delete, not the most recent change', async () => {
      // The whole reason this is not /undo: by the time you want a page back, its delete is several
      // changes down the journal.
      reply = deleted;
      const out = await runMemoryCommand('/restore', 'people/jane');
      expect(calls[1]).toEqual({ op: 'undo', input: { change_id: 'chg_d' } });
      expect(out).toContain('people/jane');
    });

    it('says so when the named page was never deleted', async () => {
      reply = deleted;
      const out = await runMemoryCommand('/restore', 'people/nobody');
      expect(out).toContain('No deleted page');
      expect(calls).toHaveLength(1);
    });

    it('does not offer to restore a delete that was already undone', async () => {
      reply = [{ ...deleted[1]!, status: 'undone' }];
      expect(await runMemoryCommand('/restore', '')).toContain('Nothing deleted recently');
    });
  });

  describe('/download', () => {
    const BRAIN = '/tmp/luna-test-memcmd/brain';
    const ctx = { agentGroupId: 'ag-1', sessionId: 'sess-1' };

    beforeEach(() => {
      fs.rmSync('/tmp/luna-test-memcmd/sessions', { recursive: true, force: true });
      fs.mkdirSync(`${BRAIN}/receipts`, { recursive: true });
      fs.writeFileSync(`${BRAIN}/receipts/cafe.pdf`, 'pretend pdf');
      fs.writeFileSync(`${BRAIN}/receipts/cafe.jpg`, 'pretend jpg');
    });

    function rows(out: string | { text: string; files?: string[]; id?: string }[]) {
      return typeof out === 'string' ? [{ text: out }] : out;
    }

    it('stages each file where delivery looks for it, one per message', async () => {
      // Telegram's adapter throws on a message carrying two uploads, and it throws inside delivery —
      // so a single multi-file row never lands and the sweep retries it until its budget is gone.
      reply = {
        page: {
          slug: 'receipts/cafe',
          documents: [{ rel_path: 'receipts/cafe.pdf', label: 'the receipt' }, { rel_path: 'receipts/cafe.jpg' }],
        },
      };
      const out = rows(await runMemoryCommand('/download', 'receipts/cafe', ctx));
      const withFiles = out.filter((row) => row.files);
      expect(withFiles).toHaveLength(2);
      expect(withFiles.every((row) => row.files!.length === 1)).toBe(true);

      // Every row carrying a file must name the outbox directory the file was staged into, or
      // delivery sends the caption with no document attached.
      for (const row of withFiles) {
        const staged = `/tmp/luna-test-memcmd/sessions/ag-1/sess-1/outbox/${row.id}/${row.files![0]}`;
        expect(fs.existsSync(staged), staged).toBe(true);
      }
      expect(out[0]!.text).toContain('2 files');
      expect(out.some((row) => row.text.includes('the receipt'))).toBe(true);
    });

    it('refuses a path that would escape the knowledge base', async () => {
      // `rel_path` comes from memory's own index, but it is still a path being joined to a root and
      // then opened.
      fs.writeFileSync('/tmp/luna-test-memcmd/outside.txt', 'secret');
      reply = { page: { slug: 'receipts/cafe', documents: [{ rel_path: '../outside.txt' }] } };
      const out = rows(await runMemoryCommand('/download', 'receipts/cafe', ctx));
      expect(out.some((row) => row.files)).toBe(false);
    });

    it('says a file is missing rather than sending a caption alone', async () => {
      reply = { page: { slug: 'receipts/cafe', documents: [{ rel_path: 'receipts/gone.pdf' }] } };
      const out = rows(await runMemoryCommand('/download', 'receipts/cafe', ctx));
      expect(out.some((row) => row.text.includes('missing on disk'))).toBe(true);
      expect(out.some((row) => row.files)).toBe(false);
    });

    it('says so when a page has nothing attached', async () => {
      reply = { page: { slug: 'people/jane', documents: [] } };
      const out = rows(await runMemoryCommand('/download', 'people/jane', ctx));
      expect(out[0]!.text).toContain('no files attached');
    });
  });

  it('reports an outage as an outage, never as an empty memory', async () => {
    // The failure that matters. An agent — or a user — told "nothing found" concludes the thing was
    // never recorded; told "memory is down" they know to ask again later.
    fail = new MemoryUnavailable('no memory service at /tmp/x.sock');
    // Each command gets an argument it would actually act on, so every one of them reaches the
    // service and fails there rather than being turned back by its own usage check.
    const argumentFor: Record<string, string> = { '/forget': 'fct_a', '/delete': 'people/x', '/restore': '' };
    for (const command of MEMORY_COMMANDS) {
      const out = await runMemoryCommand(command, argumentFor[command] ?? 'people/x', {
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
      });
      const text = typeof out === 'string' ? out : out.map((row) => row.text).join('\n');
      expect(text, command).toMatch(/not answering/i);
      expect(text, command).toMatch(/outage, not an empty memory/i);
    }
  });
});
