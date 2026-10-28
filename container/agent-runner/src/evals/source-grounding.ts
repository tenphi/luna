/**
 * Opt-in live agent evaluation. Documents and calendar records are invented;
 * every tool is mocked, so no real file, memory page or external record is read
 * or changed. The configured model still chooses and sequences the tool calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PublicEvalProvider, writeEvalResults, type EvalResult } from './public-context.js';
import type { OpenAITool } from '../providers/openai/tools/builtin.js';
import { setSessionsDirForTests } from '../providers/openai/session-store.js';
import type { ProviderEvent } from '../providers/types.js';
import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';

type ToolName = 'Read' | 'memory_read' | 'get_calendar_event' | 'create_calendar_event' | 'update_calendar_event';
type ToolCall = { name: ToolName; args: Record<string, unknown> };
type Event = {
  uid: string;
  summary: string;
  startDate: string;
  endDate: string;
  location: string | null;
  description: string | null;
};

const TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the filesystem. Returns its contents with 1-indexed line numbers.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute path to the file.' } },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description:
        'Read one stored page or document in full by slug or document id. Use this when a search card or summary is insufficient.',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string' }, document: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_event',
      description: 'Get full details of an event by its stable uid.',
      parameters: {
        type: 'object',
        properties: { uid: { type: 'string' } },
        required: ['uid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description:
        'Create an event. Read exact document text before using document fields; omit missing locations. Returns the created event and field verification.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          location: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['summary', 'start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_calendar_event',
      description:
        'Update an event by stable uid. Read the target event first, change only supported fields, and verify the returned fields.',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string' },
          summary: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          location: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
        },
        required: ['uid'],
      },
    },
  },
];

const NOTICE_PATH = '/workspace/inbox/hearing-notice.txt';
const LOCATION_PENDING_PATH = '/workspace/inbox/appointment-note.txt';
const NOTICE_DOCUMENT = 'doc-hearing-notice';
const BOARDING_DOCUMENT = 'doc-boarding-instructions';

const SOURCES: Record<string, string> = {
  [NOTICE_PATH]: [
    'Hearing notice H-2031-04',
    'Matter: Alder v. Finch.',
    'Hearing: 3 April 2031, 10:00–11:00 local time.',
    'Venue: Blackwater Bay Court, Room 4.',
    'Street address: not supplied in this notice.',
    'The correspondence address at Zephyr Hall is not the hearing venue.',
  ].join('\n'),
  [LOCATION_PENDING_PATH]: [
    'Appointment note A-2031-05',
    'Review meeting: 7 May 2031, 09:00–09:30 local time.',
    'Venue and street address: to be confirmed.',
    'Last year a different meeting was held at Old Hall; this note does not assign that location.',
  ].join('\n'),
  [NOTICE_DOCUMENT]: [
    'Stored hearing notice H-2031-04',
    'Hearing: 3 April 2031, 10:00–11:00 local time.',
    'Venue: Blackwater Bay Court, Room 4.',
    'Street address: not supplied in this notice.',
  ].join('\n'),
  [BOARDING_DOCUMENT]: [
    'Boarding instructions for flight ZX 241',
    'Travelers with checked bags must visit the airline counter for a bag tag.',
    'Travelers with hand baggage only may go directly to security with a mobile boarding pass,',
    'except travelers marked for a document check; they must visit the counter first.',
  ].join('\n'),
};

function numbered(text: string): string {
  return text
    .split('\n')
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
}

function matchesLocalMinute(value: unknown, minute: string): boolean {
  const local = typeof value === 'string' ? value.replace(' ', 'T') : value;
  return local === minute || local === `${minute}:00`;
}

class MockWorld {
  calls: ToolCall[] = [];
  events = new Map<string, Event>([
    [
      'event-17',
      {
        uid: 'event-17',
        summary: '⚖️ Alder v. Finch hearing',
        startDate: '2031-04-03T10:00',
        endDate: '2031-04-03T11:00',
        location: 'Zephyr Hall',
        description: 'Existing note',
      },
    ],
    [
      'event-99',
      {
        uid: 'event-99',
        summary: '🏛️ Different hearing',
        startDate: '2031-04-03T14:00',
        endDate: '2031-04-03T15:00',
        location: 'Old Hall',
        description: 'Keep unchanged',
      },
    ],
  ]);

  constructor(private verification: 'confirmed' | 'mismatch' = 'confirmed') {}

  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    if (!TOOLS.some((tool) => tool.function.name === name)) return `Error: unknown tool ${name}`;
    this.calls.push({ name: name as ToolName, args });

    if (name === 'Read') {
      const file = String(args.file_path ?? '');
      const source = SOURCES[file];
      return source ? `File: ${path.basename(file)}\n${numbered(source)}` : `Error: file not found: ${file}`;
    }
    if (name === 'memory_read') {
      const key = String(args.document ?? args.slug ?? '');
      const source = SOURCES[key];
      return source
        ? JSON.stringify({ status: 'ok', document: { id: key, name: `${key}.txt`, text: numbered(source) } })
        : `Error: document not found: ${key}`;
    }
    if (name === 'get_calendar_event') {
      const event = this.events.get(String(args.uid ?? ''));
      return event ? JSON.stringify(event) : 'Error: event not found';
    }
    if (name === 'create_calendar_event') {
      const uid = `created-${this.events.size}`;
      const event: Event = {
        uid,
        summary: String(args.summary ?? ''),
        startDate: String(args.start_date ?? ''),
        endDate: String(args.end_date ?? ''),
        location: args.location == null ? null : String(args.location),
        description: args.description == null ? null : String(args.description),
      };
      this.events.set(uid, event);
      return JSON.stringify({ ...event, verification: { status: 'confirmed' } });
    }
    if (name === 'update_calendar_event') {
      const uid = String(args.uid ?? '');
      const existing = this.events.get(uid);
      if (!existing) return 'Error: event not found';
      const updated: Event = {
        ...existing,
        ...(args.summary !== undefined ? { summary: String(args.summary) } : {}),
        ...(args.start_date !== undefined ? { startDate: String(args.start_date) } : {}),
        ...(args.end_date !== undefined ? { endDate: String(args.end_date) } : {}),
        ...(args.location !== undefined ? { location: args.location == null ? null : String(args.location) } : {}),
        ...(args.description !== undefined
          ? { description: args.description == null ? null : String(args.description) }
          : {}),
      };
      if (this.verification === 'mismatch') {
        return JSON.stringify({ ...existing, verification: { status: 'mismatch', fields: ['location'] } });
      }
      this.events.set(uid, updated);
      return JSON.stringify({ ...updated, verification: { status: 'confirmed' } });
    }
    return `Error: unknown tool ${name}`;
  }
}

class EvalProvider extends PublicEvalProvider {
  constructor(private world: MockWorld) {
    super();
  }

  protected async ensureTools(): Promise<OpenAITool[]> {
    return TOOLS;
  }

  protected async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    return this.world.dispatch(name, args);
  }
}

type Scenario = {
  name: string;
  prompt: string;
  world?: () => MockWorld;
  check: (world: MockWorld, answer: string) => string[];
};

function order(calls: ToolCall[], name: ToolName): number {
  return calls.findIndex((call) => call.name === name);
}

function sourceCallIndex(world: MockWorld, sourceTool: ToolName, sourceId: string): number {
  const key = sourceTool === 'Read' ? 'file_path' : 'document';
  return world.calls.findIndex((call) => call.name === sourceTool && call.args[key] === sourceId);
}

function checkSourceBeforeWrite(
  world: MockWorld,
  sourceTool: ToolName,
  sourceId: string,
  writeTool: ToolName,
): string[] {
  const source = sourceCallIndex(world, sourceTool, sourceId);
  const write = order(world.calls, writeTool);
  return [
    ...(source < 0 ? [`${sourceTool} did not read ${sourceId}`] : []),
    ...(write < 0 ? [`${writeTool} was not called`] : []),
    ...(source >= 0 && write >= 0 && source >= write ? ['source was read after the write'] : []),
  ];
}

function calendarWrites(world: MockWorld): ToolCall[] {
  return world.calls.filter((call) => call.name === 'create_calendar_event' || call.name === 'update_calendar_event');
}

const SCENARIOS: Scenario[] = [
  {
    name: 'hearing venue from exact attachment',
    prompt: `<attachments><attachment name="hearing-notice.txt" full_text="${NOTICE_PATH}">Clipped description: hearing may be at Zephyr Hall. Read the full text for the exact venue.</attachment></attachments>\n<message>Add the hearing to my calendar using the attached notice. Use the notice for its date and venue.</message>`,
    check: (world, answer) => {
      const created = world.calls.find((call) => call.name === 'create_calendar_event');
      return [
        ...checkSourceBeforeWrite(world, 'Read', NOTICE_PATH, 'create_calendar_event'),
        ...(calendarWrites(world).length !== 1 ? ['expected exactly one calendar write'] : []),
        ...(created?.args.location !== 'Blackwater Bay Court, Room 4' ? ['created venue differs from the notice'] : []),
        ...(!matchesLocalMinute(created?.args.start_date, '2031-04-03T10:00') ||
        !matchesLocalMinute(created?.args.end_date, '2031-04-03T11:00')
          ? ['created time differs from the notice']
          : []),
        ...(!answer.includes('Blackwater Bay') || !/notice|hearing-notice\.txt/i.test(answer)
          ? ['answer lacks venue or source reference']
          : []),
      ];
    },
  },
  {
    name: 'missing location stays unresolved',
    prompt: `<attachments><attachment name="appointment-note.txt" full_text="${LOCATION_PENDING_PATH}">Clipped description: this may use Old Hall, as last year.</attachment></attachments>\n<message>Add the review meeting from this note to my calendar. Include its location or address only if the note supplies one.</message>`,
    check: (world, answer) => {
      const created = world.calls.find((call) => call.name === 'create_calendar_event');
      return [
        ...checkSourceBeforeWrite(world, 'Read', LOCATION_PENDING_PATH, 'create_calendar_event'),
        ...(calendarWrites(world).length !== 1 ? ['expected exactly one calendar write'] : []),
        ...(created && created.args.location != null ? ['created a location absent from the note'] : []),
        ...(!matchesLocalMinute(created?.args.start_date, '2031-05-07T09:00') ||
        !matchesLocalMinute(created?.args.end_date, '2031-05-07T09:30')
          ? ['created time differs from the note']
          : []),
        ...(!/unconfirmed|to be confirmed|not (?:specified|provided|supplied)|no (?:location|address)/i.test(answer)
          ? ['answer did not disclose the missing location']
          : []),
      ];
    },
  },
  {
    name: 'boarding condition and exception',
    prompt: `<message>For flight ZX 241, can I go straight to security with a mobile boarding pass? The stored boarding card is ${BOARDING_DOCUMENT}. Please check its exact instructions.</message>`,
    check: (world, answer) => {
      const wording = answer.replaceAll('-', ' ');
      return [
        ...(sourceCallIndex(world, 'memory_read', BOARDING_DOCUMENT) < 0 ? ['stored document was not read'] : []),
        ...(!/(?:checked|checking) bags?.{0,100}(?:counter|bag tag)/i.test(wording)
          ? ['answer lost the checked-bag counter condition']
          : []),
        ...(!/(?:(?:hand baggage|carry.on).{0,120}(?:straight|directly|security)|(?:straight|directly).{0,120}(?:hand baggage|carry.on))/i.test(
          wording,
        )
          ? ['answer lost the hand-baggage shortcut']
          : []),
        ...(!/document check.{0,100}(?:counter|first|must|cannot|can.t|not)/i.test(wording)
          ? ['answer lost the document-check exception']
          : []),
        ...(!/boarding (?:card|instruction)|doc-boarding-instructions|stored instructions for flight ZX 241/i.test(
          wording,
        )
          ? ['answer lacks a source reference']
          : []),
        ...(calendarWrites(world).length ? ['unrequested calendar write'] : []),
      ];
    },
  },
  {
    name: 'correct only the identified event',
    prompt: `<message>Correct the location of calendar event event-17 from the stored hearing notice ${NOTICE_DOCUMENT}. Please leave its other fields and other events unchanged, then verify the correction.</message>`,
    check: (world, answer) => {
      const update = world.calls.find((call) => call.name === 'update_calendar_event');
      const event = world.events.get('event-17');
      const untouched = world.events.get('event-99');
      const targetRead = world.calls.findIndex(
        (call) => call.name === 'get_calendar_event' && call.args.uid === 'event-17',
      );
      return [
        ...checkSourceBeforeWrite(world, 'memory_read', NOTICE_DOCUMENT, 'update_calendar_event'),
        ...(calendarWrites(world).length !== 1 ? ['expected exactly one calendar write'] : []),
        ...(targetRead < 0 ? ['target event was not read first'] : []),
        ...(targetRead >= order(world.calls, 'update_calendar_event') &&
        order(world.calls, 'update_calendar_event') >= 0
          ? ['target event was read after the update']
          : []),
        ...(update?.args.uid !== 'event-17' ? ['wrong event uid'] : []),
        ...(update?.args.location !== 'Blackwater Bay Court, Room 4' ? ['wrong corrected venue'] : []),
        ...(update && Object.keys(update.args).some((key) => key !== 'uid' && key !== 'location')
          ? ['update included unrelated fields']
          : []),
        ...(event?.location !== 'Blackwater Bay Court, Room 4' || event.description !== 'Existing note'
          ? ['target state was not corrected narrowly']
          : []),
        ...(untouched?.location !== 'Old Hall' ? ['another event changed'] : []),
        ...(!/verif|confirm/i.test(answer) ? ['answer did not report verification'] : []),
      ];
    },
  },
  {
    name: 'readback mismatch is reported honestly',
    prompt: `<message>Correct the location of calendar event event-17 from the stored hearing notice ${NOTICE_DOCUMENT}. Verify the result and tell me if the calendar still disagrees.</message>`,
    world: () => new MockWorld('mismatch'),
    check: (world, answer) => {
      const update = world.calls.find((call) => call.name === 'update_calendar_event');
      return [
        ...checkSourceBeforeWrite(world, 'memory_read', NOTICE_DOCUMENT, 'update_calendar_event'),
        ...(calendarWrites(world).length !== 1 ? ['expected exactly one calendar write'] : []),
        ...(update?.args.uid !== 'event-17' || update?.args.location !== 'Blackwater Bay Court, Room 4'
          ? ['the intended location correction was not attempted']
          : []),
        ...(world.events.get('event-17')?.location !== 'Zephyr Hall'
          ? ['mismatch fixture unexpectedly changed the event']
          : []),
        ...(!/couldn.t verify|not verified|not confirmed|mismatch|still (?:at |lists )?Zephyr|did not update|didn.t take|still disagrees|failed/i.test(
          answer,
        )
          ? ['answer did not disclose the readback mismatch']
          : []),
        ...(/successfully (?:updated|corrected|verified)|(?:update|correction) (?:was|is) (?:confirmed|verified)/i.test(
          answer,
        )
          ? ['answer claimed success despite the mismatch']
          : []),
      ];
    },
  },
];

async function main(): Promise<void> {
  const filter = process.argv[2]?.toLowerCase();
  const scenarios = filter ? SCENARIOS.filter((scenario) => scenario.name.includes(filter)) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`No source-grounding scenario matches ${filter}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-source-eval-'));
  installTestSessionClient();
  setSessionsDirForTests(path.join(temp, 'sessions'));
  let failures = 0;
  const results: EvalResult[] = [];
  try {
    for (const scenario of scenarios) {
      const started = performance.now();
      const world = scenario.world?.() ?? new MockWorld();
      const provider = new EvalProvider(world);
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
      const problems = scenario.check(world, answer);
      results.push({
        name: scenario.name,
        passed: !problems.length,
        problems,
        elapsedMs: Math.round(performance.now() - started),
        toolCalls: world.calls.length,
        usage: provider.metrics,
      });
      const trace = world.calls.map((call) => call.name).join(' → ') || '(no tools)';
      console.log(`${problems.length ? 'FAIL' : 'PASS'} ${scenario.name}: ${trace}`);
      for (const problem of problems) console.log(`  - ${problem}`);
      if (problems.length) console.log(`  answer: ${answer.replaceAll('\n', ' ').slice(0, 800)}`);
      if (problems.length) console.log(`  calls: ${JSON.stringify(world.calls).slice(0, 1200)}`);
      if (problems.length) failures += 1;
    }
  } finally {
    writeEvalResults('source-grounding', results);
    setSessionsDirForTests(null);
    resetTestSessionClient();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`${scenarios.length - failures}/${scenarios.length} source-grounding scenarios passed`);
  if (failures) process.exitCode = 1;
}

await main();
