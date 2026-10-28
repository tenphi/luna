/** Live model routing check with invented sources and mocked memory tools. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { PublicEvalProvider, writeEvalResults, type EvalResult } from './public-context.js';
import type { OpenAITool } from '../providers/openai/tools/builtin.js';
import { setSessionsDirForTests } from '../providers/openai/session-store.js';
import type { ProviderEvent } from '../providers/types.js';
import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';

// Load the pure host renderer at this evaluation boundary without expanding the runner's build root.
const { prepareReference } = (await import(
  pathToFileURL(path.resolve(import.meta.dir, '../../../../src/host-mcp/builtins/memory/servers/reference-content.ts'))
    .href
)) as {
  prepareReference(input: Record<string, unknown>): {
    content: string;
    complete: boolean;
    rowCount: number;
    issues: string[];
  };
};
type Call = { name: string; args: Record<string, unknown> };

const TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_retain',
      description:
        'Save a complete reference as one source page without fact extraction. For ordered scans pass parts and expected_parts. For transactions pass rows with date, route, amount, currency, source_parts and uncertainty. A cropped or unreadable field yields a preserved but partial page; repeating the same call cannot fix missing pixels. Complete success requires preserved: true and complete: true after readback.',
      parameters: {
        type: 'object',
        properties: {
          source_slug: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          replace_existing: { type: 'boolean' },
          expected_parts: { type: 'integer' },
          parts: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, text: { type: 'string' }, unreadable: { type: 'string' } },
              required: ['name'],
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                transaction_id: { type: 'string' },
                date: { type: ['string', 'null'] },
                route: { type: ['string', 'null'] },
                amount: { type: ['string', 'null'] },
                currency: { type: ['string', 'null'] },
                source_parts: { type: 'array', items: { type: 'integer' } },
                uncertainty: { type: 'string' },
              },
              required: ['date', 'route', 'amount', 'currency', 'source_parts'],
            },
          },
        },
        required: ['source_slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Read one existing memory page by its slug before replacing it.',
      parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_ingest',
      description:
        'Preserve original file bytes and extract searchable text. Use when the owner wants the original binary kept.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, folder: { type: 'string' } },
        required: ['path', 'folder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description: 'Extract durable personal facts from ordinary conversation; not for reference documents.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
];

class MockMemory {
  calls: Call[] = [];
  oldStubReplaced = false;
  pages = new Map<string, string>();

  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, args });
    if (name === 'memory_read') {
      const slug = String(args.slug);
      const stored = this.pages.get(slug);
      if (stored === undefined && slug !== 'resources/old-stub')
        return JSON.stringify({ status: 'missing', page: null });
      return JSON.stringify({
        status: 'ok',
        page: {
          slug,
          role: 'source',
          lines: (stored ?? 'Old summary-only stub').split('\n').map((text, index) => ({ n: index + 1, text })),
          documents:
            slug === 'resources/old-stub' ? [{ id: 'old-image-1', rel_path: 'resources/old-stub/old-image.png' }] : [],
        },
      });
    }
    if (name === 'memory_retain') {
      if (args.source_slug === 'resources/old-stub' && args.replace_existing !== true) {
        return JSON.stringify({
          status: 'ok',
          outcome: 'held',
          preserved: false,
          reason: 'destination_exists',
          note: 'A different page already exists. Read it and pass replace_existing: true only if the new source replaces it.',
        });
      }
      if (args.source_slug === 'resources/old-stub') this.oldStubReplaced = true;
      const prepared = prepareReference(args);
      this.pages.set(String(args.source_slug), prepared.content);
      const partial = !prepared.complete;
      return JSON.stringify({
        status: 'ok',
        outcome: partial ? 'partial' : 'preserved',
        preserved: true,
        complete: !partial,
        source_slug: args.source_slug,
        parts: args.expected_parts,
        rows: prepared.rowCount,
        issues: prepared.issues,
        ...(args.source_slug === 'resources/old-stub'
          ? { previous_documents: ['old-image-1'], original_links_reconciled: true }
          : {}),
        note: partial
          ? 'A partial source page was written and read back. Report the listed gaps and keep the original part count. Do not repeat or replace this page until clearer source evidence is available.'
          : 'The complete source page was written and read back.',
      });
    }
    if (name === 'memory_ingest')
      return JSON.stringify({
        status: 'ok',
        outcome: 'ok',
        slug: 'resources/original-image',
        documents: [{ id: 'invented-image' }],
      });
    if (name === 'memory_remember') return JSON.stringify({ status: 'ok', outcome: 'noop' });
    return 'Error: unknown tool';
  }
}

class EvalProvider extends PublicEvalProvider {
  constructor(private memory: MockMemory) {
    super();
  }

  protected async ensureTools(): Promise<OpenAITool[]> {
    return TOOLS;
  }
  protected async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    return this.memory.dispatch(name, args);
  }
}

const scanPages = Array.from({ length: 10 }, (_, i) => ({
  name: `scan-${i + 1}.png`,
  text: `Page ${i + 1}: clause ZX-${100 + i} applies only to section ${i + 1}.`,
}));
const screenshots = Array.from({ length: 7 }, (_, i) => ({
  name: `ticket-${i + 1}.png`,
  text:
    i === 6
      ? 'Transaction T-7. Date 2031-04-07. Route Bay to Hill. Amount is cropped out.'
      : `Transaction T-${i === 5 ? 1 : i + 1}. Date 2031-04-${String(i === 5 ? 1 : i + 1).padStart(2, '0')}. Route Bay to Hill. EUR ${(i === 5 ? 1 : i + 1) * 3}.50.`,
}));

type Scenario = { name: string; prompt: string; check: (memory: MockMemory, answer: string) => string[] };
const scenarios: Scenario[] = [
  {
    name: 'ten ordered scans become one complete source',
    prompt: `<attachments>\n${scanPages.map((part) => `<attachment name="${part.name}" content="complete-verified-transcript">${part.text}</attachment>`).join('\n')}\n</attachments>\n<message>The attachment blocks above contain complete verified transcripts of these synthetic one-line pages, including their printed Page labels. Save the exact text of all ten ordered scans together as one complete reference page under resources. I do not need the original image files kept. Please do not extract personal facts from the guide.</message>`,
    check: (memory, answer) => {
      const saves = memory.calls.filter((call) => call.name === 'memory_retain');
      const args = saves.at(-1)?.args;
      const parts = Array.isArray(args?.parts) ? (args.parts as Array<{ name?: string; text?: string }>) : [];
      const slug = String(args?.source_slug ?? '');
      const correctedSafely = saves.slice(1).every((save) => {
        const position = memory.calls.indexOf(save);
        return (
          save.args.source_slug === slug &&
          save.args.replace_existing === true &&
          memory.calls.slice(0, position).some((call) => call.name === 'memory_read' && call.args.slug === slug)
        );
      });
      return [
        ...(!saves.length || memory.pages.size !== 1 || !correctedSafely
          ? ['expected one source page with readback before corrections']
          : []),
        ...(args?.expected_parts !== 10 || parts.length !== 10 ? ['source page does not cover ten ordered parts'] : []),
        ...scanPages.flatMap((page, i) =>
          (parts[i]?.name?.includes(page.name) || parts[i]?.name === `Page ${i + 1}`) &&
          parts[i]?.text?.includes(page.text) &&
          memory.pages.get(slug)?.includes(page.text)
            ? []
            : [`missing exact page ${i + 1}`],
        ),
        ...(memory.calls.some((call) => call.name === 'memory_ingest' || call.name === 'memory_remember')
          ? ['unrequested binary ingest or fact extraction']
          : []),
        ...(!/sav|preserv|retained/i.test(answer) ? ['answer did not report the saved result'] : []),
      ];
    },
  },
  {
    name: 'seven screenshots become qualified transaction rows',
    prompt: `<attachments>\n${screenshots.map((part) => `<attachment name="${part.name}">${part.text}</attachment>`).join('\n')}\n</attachments>\n<message>Save these seven ticket screenshots as one transaction record page under resources. Deduplicate the duplicate ticket, keep dates, routes and amounts, and say what is unreadable. I do not need the original image files kept.</message>`,
    check: (memory, answer) => {
      const saves = memory.calls.filter((call) => call.name === 'memory_retain');
      const args = saves[0]?.args;
      const parts = Array.isArray(args?.parts) ? (args.parts as Array<{ name?: string }>) : [];
      const rows = Array.isArray(args?.rows) ? (args.rows as Array<Record<string, unknown>>) : [];
      const covered = new Set(
        rows.flatMap((row) => (Array.isArray(row.source_parts) ? (row.source_parts as number[]) : [])),
      );
      return [
        ...(saves.length !== 1 ? ['expected one structured source-page save'] : []),
        ...(args?.expected_parts !== 7 || parts.length !== 7 ? ['not all screenshot parts were included'] : []),
        ...(rows.length < 6 ? ['too few transaction rows'] : []),
        ...([1, 2, 3, 4, 5, 6, 7].some((n) => !covered.has(n)) ? ['some screenshots have no row'] : []),
        ...(!rows.some(
          (row) =>
            row.transaction_id === 'T-1' &&
            Array.isArray(row.source_parts) &&
            row.source_parts.includes(1) &&
            row.source_parts.includes(6),
        )
          ? ['duplicate ticket not linked to both screenshots']
          : []),
        ...(!rows.some(
          (row) => row.transaction_id === 'T-7' && row.amount === null && typeof row.uncertainty === 'string',
        )
          ? ['cropped amount was invented or uncertainty omitted']
          : []),
        ...(memory.calls.some((call) => call.name === 'memory_ingest' || call.name === 'memory_remember')
          ? ['unrequested binary ingest or fact extraction']
          : []),
        ...(!/cropped|unreadable|unknown|partial|couldn.t read/i.test(answer)
          ? ['answer hid the incomplete amount']
          : []),
      ];
    },
  },
  {
    name: 'verified replacement keeps old originals visible',
    prompt:
      '<attachments><attachment name="new-page-1.png">Page 1: Permit A-51 is valid through 2031-05-01.</attachment><attachment name="new-page-2.png">Page 2: Permit A-51 excludes commercial use.</attachment></attachments>\n<message>Replace the old summary-only source page at resources/old-stub with the exact text of these two ordered pages. Read the old page first. Do not delete any original image files.</message>',
    check: (memory, answer) => {
      const read = memory.calls.findIndex(
        (call) => call.name === 'memory_read' && call.args.slug === 'resources/old-stub',
      );
      const replacement = memory.calls.findIndex(
        (call) => call.name === 'memory_retain' && call.args.replace_existing === true,
      );
      const args = memory.calls[replacement]?.args;
      const parts = Array.isArray(args?.parts) ? (args.parts as Array<{ text?: string }>) : [];
      return [
        ...(read < 0 || replacement <= read ? ['existing source was not read before replacement'] : []),
        ...(args?.expected_parts !== 2 || parts.length !== 2 ? ['replacement lost a page'] : []),
        ...(!parts[0]?.text?.includes('valid through 2031-05-01') ||
        !parts[1]?.text?.includes('excludes commercial use')
          ? ['replacement lost exact source details']
          : []),
        ...(memory.calls.some((call) => call.name === 'memory_ingest' || call.name === 'memory_remember')
          ? ['unexpected file or fact mutation']
          : []),
        ...(!/old|original|previous|remain|retained|not delet/i.test(answer)
          ? ['answer did not distinguish prior originals']
          : []),
      ];
    },
  },
  {
    name: 'explicit original-file request still ingests',
    prompt:
      '<attachments><attachment name="diagram.png" path="/workspace/inbox/example/diagram.png">An invented wiring diagram.</attachment></attachments>\n<message>Keep the original diagram.png file in memory under resources. I want the image itself, not a text transcription.</message>',
    check: (memory) => [
      ...(!memory.calls.some(
        (call) => call.name === 'memory_ingest' && call.args.path === '/workspace/inbox/example/diagram.png',
      )
        ? ['original file was not ingested']
        : []),
      ...(memory.calls.some((call) => call.name === 'memory_retain' || call.name === 'memory_remember')
        ? ['unrequested text or fact save']
        : []),
    ],
  },
];

async function main(): Promise<void> {
  const filter = process.argv[2]?.toLowerCase();
  const selected = filter ? scenarios.filter((scenario) => scenario.name.includes(filter)) : scenarios;
  if (!selected.length) throw new Error(`No reference-capture scenario matches ${filter}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-reference-eval-'));
  installTestSessionClient();
  setSessionsDirForTests(path.join(temp, 'sessions'));
  let failures = 0;
  const results: EvalResult[] = [];
  try {
    for (const scenario of selected) {
      const started = performance.now();
      const memory = new MockMemory();
      const provider = new EvalProvider(memory);
      const query = provider.query({
        prompt: scenario.prompt,
        cwd: temp,
        senderIsPrivileged: true,
      });
      query.end();
      let answer = '';
      for await (const event of query.events as AsyncIterable<ProviderEvent>) {
        if (event.type === 'result' && event.text) answer += event.text;
      }
      const problems = scenario.check(memory, answer);
      results.push({
        name: scenario.name,
        passed: !problems.length,
        problems,
        elapsedMs: Math.round(performance.now() - started),
        toolCalls: memory.calls.length,
        usage: provider.metrics,
      });
      console.log(
        `${problems.length ? 'FAIL' : 'PASS'} ${scenario.name}: ${memory.calls.map((call) => call.name).join(' → ') || '(no tools)'}`,
      );
      for (const problem of problems) console.log(`  - ${problem}`);
      if (problems.length) {
        console.log(`  answer: ${answer.replaceAll('\n', ' ').slice(0, 800)}`);
        console.log(`  calls: ${JSON.stringify(memory.calls).slice(0, 3000)}`);
        failures++;
      }
    }
  } finally {
    writeEvalResults('reference-capture', results);
    setSessionsDirForTests(null);
    resetTestSessionClient();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`${selected.length - failures}/${selected.length} reference-capture scenarios passed`);
  if (failures) process.exitCode = 1;
}

await main();
