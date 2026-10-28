import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { APIConnectionError, APIError, RateLimitError } from 'openai';

import { OpenAIProvider, buildRecallQuery, mergeStreamedToolName, type ChatCompletionsClient } from './index.js';
import { installTestSessionClient, resetTestSessionClient } from '../../session/test-support.js';
import { getSessionClient, type InMemorySessionClient } from '../../session/client.js';
import { getContextSummary } from '../../db/session-state.js';
import { PROCESS_UPDATE_MARKER } from '../../reply-contract.js';
import type { ProviderEvent } from '../types.js';
import type { OpenAITool } from './tools/builtin.js';
import type { ChatMessage } from './types.js';
import { loadHistory, saveHistory, setSessionsDirForTests, sessionExists } from './session-store.js';

// A fake streaming completion: each queued "turn" is a list of stream chunks.
function makeStream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function textDelta(text: string) {
  return { choices: [{ delta: { content: text } }] };
}

function reasoningDelta(text: string) {
  return { choices: [{ delta: { content: '', reasoning_content: text } }] };
}

function toolCallDelta(id: string, name: string, args: string) {
  return {
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
  };
}

/** A spec-compliant fragment: the endpoint numbers every tool call. */
function indexedToolCallDelta(index: number, id: string | undefined, name: string, args: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index, ...(id ? { id } : {}), function: { name, arguments: args } }],
        },
      },
    ],
  };
}

/**
 * A gateway that stamps the same `index` on every call in a batch (or omits it
 * entirely when `index` is undefined). Only the id distinguishes the calls.
 */
function unindexedToolCallDelta(id: string | undefined, name: string, args: string, index?: number) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            { ...(index === undefined ? {} : { index }), ...(id ? { id } : {}), function: { name, arguments: args } },
          ],
        },
      },
    ],
  };
}

function finishChunk(reason: string) {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function autoRecallResult(
  text = 'Ada Marlow prefers morning meetings.',
  referenceResolution: 'not_needed' | 'resolved' | 'ambiguous' | 'unresolved' = 'not_needed',
): string {
  return JSON.stringify({
    status: 'ok',
    profile: 'auto_recall',
    results: [
      {
        type: 'page',
        slug: 'people/ada-marlow',
        lines: [{ n: 7, text }],
      },
    ],
    activation: {
      activated: true,
      basis: 'exact',
      candidates: 1,
      selected: 1,
      qualification_run: false,
      reference_resolution: referenceResolution,
    },
    budget_used: 19,
  });
}

/**
 * Test double: replaces the live OpenAI client with a scripted one and stubs
 * the tool surface so no real MCP servers or built-ins run unless we want them.
 */
class TestProvider extends OpenAIProvider {
  private turns: unknown[][];
  public dispatched: { name: string; args: Record<string, unknown> }[] = [];
  public requests: ChatMessage[][] = [];
  public requestTools: OpenAITool[][] = [];
  public requestToolChoices: unknown[] = [];

  constructor(
    turns: unknown[][],
    dispatch?: (name: string) => string,
    opts?: { context?: { summarization?: 'deterministic'; keepRecentTurns?: number; promptCacheKey?: string } },
  ) {
    super({ model: 'test-model', mcpServers: {}, context: opts?.context });
    this.turns = turns;
    this.client = {
      chat: {
        completions: {
          create: async (params: { messages: ChatMessage[]; tools: OpenAITool[]; tool_choice?: unknown }) => {
            this.requests.push(params.messages);
            this.requestTools.push(params.tools);
            this.requestToolChoices.push(params.tool_choice);
            return makeStream(this.turns.shift() ?? []);
          },
        },
      },
    } as ChatCompletionsClient;
    this.dispatchImpl = dispatch ?? (() => 'TOOL_RESULT');
  }

  private dispatchImpl: (name: string) => string;

  protected async ensureTools(): Promise<OpenAITool[]> {
    return [
      {
        type: 'function',
        function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
      },
    ];
  }

  protected async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.dispatched.push({ name, args });
    return this.dispatchImpl(name);
  }
}

describe('tool budget finalization', () => {
  const toolRounds = () => Array.from({ length: 100 }, (_, i) => [toolCallDelta(`budget_${i}`, 'TestTool', '{}')]);
  const partialReport =
    'Partial report: Vulpine Mutual confirmed a review on 12 April 2031. Email coverage is incomplete because the tool limit was reached.';
  const qualifiedReport = `The tool limit interrupted this run; the result below may be incomplete.\n\n${partialReport}`;

  it('summarizes collected evidence in one tools-disabled completion and persists the report', async () => {
    const provider = new TestProvider(
      [...toolRounds(), [textDelta(partialReport)]],
      () => 'Vulpine Mutual confirmed a review on 12 April 2031.',
    );
    const query = provider.query({
      prompt: 'Prepare the daily report.',
      cwd: agentDir,
      taskRun: { seriesId: 'daily', runId: 'occurrence', scheduledFor: '2031-04-03T08:00:00Z' },
    });
    query.end();
    const events = await collect(query.events);
    expect(provider.dispatched).toHaveLength(100);
    expect(provider.requests).toHaveLength(101);
    expect(provider.requestTools[99]?.length).toBeGreaterThan(0);
    expect(provider.requestTools[100]).toEqual([]);
    expect(provider.requestToolChoices[100]).toBe('none');
    expect(provider.requests[100]?.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('only evidence already collected'),
    });
    expect(provider.requests[94]?.at(-1)?.content).not.toContain('tool rounds remain');
    expect(provider.requests[95]?.at(-1)?.content).toContain('Only 5 tool rounds remain');
    expect(provider.requests[99]?.at(-1)?.content).toContain('Only 1 tool round remains');
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: qualifiedReport }]);
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const saved = loadHistory(init.continuation)!;
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: qualifiedReport });
    expect(saved.some((m) => m.role === 'system')).toBe(false);
  });

  for (const [kind, chunks] of [
    ['native', [toolCallDelta('late', 'TestTool', '{}')]],
    ['textual', [textDelta('<tool_calls><invoke name="TestTool"></invoke></tool_calls>')]],
    ['empty', []],
  ] as const) {
    it(`does not dispatch or persist a ${kind} call after exhaustion`, async () => {
      const provider = new TestProvider([...toolRounds(), [...chunks]]);
      const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
      query.end();
      const events = await collect(query.events);
      expect(provider.dispatched).toHaveLength(100);
      expect(provider.requests).toHaveLength(101);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toContain('requested work is incomplete');
      expect(events.filter((e) => e.type === 'tool')).toHaveLength(100);
      const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
      const saved = loadHistory(init.continuation)!;
      expect(saved.at(-1)?.content).toBe(result.text);
      expect(saved.flatMap((m) => m.tool_calls ?? []).some((c) => c.id === 'late')).toBe(false);
      for (const message of saved) {
        for (const call of message.tool_calls ?? []) expect(saved.some((m) => m.tool_call_id === call.id)).toBe(true);
      }
    });
  }

  it('leaves normal early completion unchanged', async () => {
    const provider = new TestProvider([[toolCallDelta('early', 'TestTool', '{}')], [textDelta('Complete report.')]]);
    const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requestTools.every((tools) => tools.length > 0)).toBe(true);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'Complete report.' }]);
  });

  for (const confirmed of [true, false]) {
    it(`${confirmed ? 'suppresses a duplicate after a confirmed' : 'reports an incomplete result after a failed'} send at the limit`, async () => {
      const rounds = toolRounds();
      rounds[99] = [toolCallDelta('last_send', 'send_message', '{"to":"owner","text":"Report."}')];
      const provider = new TestProvider([...rounds, []], (name) =>
        name === 'send_message' ? (confirmed ? 'Message sent to owner (id: 7)' : 'Error: send failed') : 'Evidence',
      );
      const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
      query.end();
      const events = await collect(query.events);
      expect(provider.requests).toHaveLength(101);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      if (confirmed) expect(result.text).toBeNull();
      else expect(result.text).toContain('requested work is incomplete');
    });
  }

  it('does not start finalization after cancellation during the last tool round', async () => {
    const provider = new TestProvider([...toolRounds(), [textDelta(partialReport)]]);
    const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
    query.end();
    let calls = 0;
    const events: ProviderEvent[] = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'tool' && ++calls === 100) query.abort();
    }
    expect(provider.requests).toHaveLength(100);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('recovers a report when an earlier send was only a process update', async () => {
    const rounds = toolRounds();
    rounds[0] = [toolCallDelta('progress_only', 'send_message', '{"text":"Still reviewing."}')];
    const provider = new TestProvider([...rounds, [textDelta(partialReport)]], (name) =>
      name === 'send_message'
        ? PROCESS_UPDATE_MARKER + 'Temporary process note; the reply still has to be written.'
        : 'Evidence',
    );
    const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: qualifiedReport }]);
  });

  it('never re-enables tools when finalization retries a transient provider failure', async () => {
    const requests: Record<string, unknown>[] = [];
    let dispatched = 0;
    const priorDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0';
    try {
      class RetryingProvider extends OpenAIProvider {
        constructor() {
          super({ model: 'test-model', mcpServers: {} });
          this.client = {
            chat: {
              completions: {
                create: async (params: Record<string, unknown>) => {
                  requests.push(params);
                  if (requests.length === 101)
                    throw new APIConnectionError({ message: 'temporary connection failure' });
                  return makeStream(
                    requests.length <= 100
                      ? [toolCallDelta(`round_${requests.length}`, 'TestTool', '{}')]
                      : [textDelta(partialReport)],
                  );
                },
              },
            },
          } as ChatCompletionsClient;
        }
        protected async ensureTools(): Promise<OpenAITool[]> {
          return [];
        }
        protected async dispatchTool(): Promise<string> {
          dispatched++;
          return 'Evidence';
        }
      }
      const query = new RetryingProvider().query({ prompt: 'Prepare the report.', cwd: agentDir });
      query.end();
      const events = await collect(query.events);
      expect(dispatched).toBe(100);
      expect(requests).toHaveLength(102);
      for (const request of requests.slice(-2)) expect(request).toMatchObject({ tools: [], tool_choice: 'none' });
      expect(requests[100]?.messages).toEqual(requests[101]?.messages);
      expect(events.some((e) => e.type === 'progress')).toBe(true);
      expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: qualifiedReport }]);
    } finally {
      if (priorDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = priorDelays;
    }
  });

  it('disables tools after non-stream request overrides and records finalization usage', async () => {
    const requests: Record<string, unknown>[] = [];
    class OverrideProvider extends OpenAIProvider {
      constructor() {
        super({
          model: 'test-model',
          mcpServers: {},
          env: {
            OPENAI_EXTRA_BODY: JSON.stringify({
              stream: false,
              tools: [{ type: 'function', function: { name: 'TestTool' } }],
              tool_choice: 'required',
              parallel_tool_calls: true,
              functions: [{}],
              function_call: 'auto',
            }),
          },
        });
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                requests.push(params);
                return {
                  choices: [
                    {
                      message:
                        requests.length <= 100
                          ? {
                              content: null,
                              tool_calls: [
                                {
                                  id: `call_${requests.length}`,
                                  type: 'function',
                                  function: { name: 'TestTool', arguments: '{}' },
                                },
                              ],
                            }
                          : { content: partialReport },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 11, completion_tokens: 22 },
                };
              },
            },
          },
        } as ChatCompletionsClient;
      }
      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
      protected async dispatchTool(): Promise<string> {
        return 'Evidence';
      }
    }
    const provider = new OverrideProvider();
    const query = provider.query({ prompt: 'Prepare the report.', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    expect(requests).toHaveLength(101);
    expect(requests[100]).toMatchObject({ tools: [], tool_choice: 'none', stream: false });
    expect(requests[100]).not.toHaveProperty('parallel_tool_calls');
    expect(requests[100]).not.toHaveProperty('functions');
    expect(requests[100]).not.toHaveProperty('function_call');
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: qualifiedReport }]);
    expect((getSessionClient() as InMemorySessionClient).usage).toHaveLength(101);
  });
});

it('sends uncertain topic placement as trusted guidance separate from quoted memory', async () => {
  const provider = new TestProvider([[textDelta('ok')]]);
  const history: ChatMessage[] = [{ role: 'user', content: 'Explain volcanoes.' }];
  const run = (provider as unknown as { runTurn: (...args: unknown[]) => AsyncIterable<ProviderEvent> }).runTurn(
    history,
    'Base instructions',
    '[quoted memory]',
    [],
    {
      isAborted: () => false,
      hasPending: () => false,
      takePending: () => null,
      signal: new AbortController().signal,
    },
    false,
    true,
  );
  for await (const _event of run) {
    // The request itself is the evidence for this test.
  }
  expect(provider.requests[0]?.map((message) => message.role)).toEqual(['system', 'system', 'user', 'user']);
  expect(provider.requests[0]?.[1]?.content).toContain('Topic classification was inconclusive');
  expect(provider.requests[0]?.[2]?.content).toBe('[quoted memory]');
});

/**
 * Test double with api.openai.com's message validation: an assistant message
 * may only carry `content: null` when it also carries `tool_calls`. Records
 * every request so a test can inspect what actually went on the wire.
 */
class StrictContentProvider extends OpenAIProvider {
  public requests: { role: string; content: unknown; tool_calls?: unknown[] }[][] = [];

  constructor(turns: unknown[][]) {
    super({ model: 'test-model', mcpServers: {} });
    const queue = [...turns];
    this.client = {
      chat: {
        completions: {
          create: async (params: { messages: ChatMessage[] }) => {
            this.requests.push(params.messages as never);
            for (const m of params.messages) {
              if (m.role === 'assistant' && m.content == null && !m.tool_calls?.length) {
                throw new APIError(
                  400,
                  { message: "Invalid value for 'content': expected a string, got null." },
                  "400 Invalid value for 'content': expected a string, got null.",
                  undefined,
                );
              }
            }
            return makeStream(queue.shift() ?? []);
          },
        },
      },
    } as unknown as ChatCompletionsClient;
  }

  protected async ensureTools(): Promise<OpenAITool[]> {
    return [
      {
        type: 'function',
        function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
      },
    ];
  }

  protected async dispatchTool(): Promise<string> {
    return 'TOOL_RESULT';
  }
}

// Simulates a gpt-5.x gateway model that 400s on `reasoning_effort` + function
// tools (like `gpt-5.6-luna`) until the provider retries with `'none'`. Also
// rejects when the field is omitted — matching gateways that apply a non-none
// default. Records the `reasoning_effort` seen on every create.
class EffortRejectProvider extends OpenAIProvider {
  public seenEfforts: (string | undefined)[] = [];

  constructor(turns: unknown[][], opts?: { effort?: string; model?: string }) {
    super({ model: opts?.model || 'gpt-5.6-luna', effort: opts?.effort, mcpServers: {} });
    const queue = [...turns];
    this.client = {
      chat: {
        completions: {
          create: async (params: { reasoning_effort?: string }) => {
            this.seenEfforts.push(params.reasoning_effort);
            // Reject unless the client explicitly sent 'none' (gateway default
            // when omitted is treated as non-none).
            if (params.reasoning_effort !== 'none') {
              throw new Error(
                "400 Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
              );
            }
            return makeStream(queue.shift() ?? []);
          },
        },
      },
    } as unknown as ChatCompletionsClient;
  }

  protected async ensureTools(): Promise<OpenAITool[]> {
    return [
      {
        type: 'function',
        function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
      },
    ];
  }

  protected async dispatchTool(): Promise<string> {
    return 'TOOL_RESULT';
  }
}

/**
 * An endpoint that objects to the *parameter* without naming a remedy — it never
 * says "set reasoning_effort to 'none'". `accepts` decides whether dropping the
 * field is enough: `'omitted'` models a server that reasons fine on its own,
 * `'none-only'` one that insists on the explicit value without saying so.
 */
class GenericEffortRejectProvider extends OpenAIProvider {
  public seenEfforts: Array<string | undefined | 'absent'> = [];

  constructor(turns: unknown[][], accepts: 'omitted' | 'none-only', opts?: { effort?: string }) {
    super({ model: 'gpt-5-mini', effort: opts?.effort, mcpServers: {} });
    const queue = [...turns];
    this.client = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            const has = 'reasoning_effort' in params;
            this.seenEfforts.push(has ? (params.reasoning_effort as string | undefined) : 'absent');
            const ok = accepts === 'omitted' ? !has : params.reasoning_effort === 'none';
            if (!ok) {
              // No "set it to 'none'" instruction — just a refusal.
              throw new Error('400 Function tools with reasoning_effort are not supported for this model.');
            }
            return makeStream(queue.shift() ?? []);
          },
        },
      },
    } as unknown as ChatCompletionsClient;
  }

  protected async ensureTools(): Promise<OpenAITool[]> {
    return [
      {
        type: 'function',
        function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
      },
    ];
  }

  protected async dispatchTool(): Promise<string> {
    return 'TOOL_RESULT';
  }
}

class DispatchProbeProvider extends OpenAIProvider {
  constructor() {
    super({ model: 'test-model', mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } } });
  }

  async callDispatch(name: string, args: Record<string, unknown>): Promise<string> {
    return this.dispatchTool(name, args);
  }
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let agentDir: string;

let sessionsDir: string;

beforeEach(() => {
  installTestSessionClient();
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-loop-'));
  sessionsDir = path.join(agentDir, '.openai-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  setSessionsDirForTests(sessionsDir);
});

afterEach(() => {
  setSessionsDirForTests(null);
  resetTestSessionClient();
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe('buildRecallQuery', () => {
  const evidence = (gist: string) => ({
    count: 1,
    imageCount: 0,
    documentCount: 1,
    gist,
    titleHint: '',
  });

  it('is just the user text when nothing was attached', () => {
    expect(buildRecallQuery('what did I pay for water last year?')).toBe('what did I pay for water last year?');
    expect(buildRecallQuery('hi', evidence(''))).toBe('hi');
  });

  it('is the attachment gist alone for a caption-less file', () => {
    // The regression: this used to be the XML envelope, so memory embedded
    // `<context timezone=…>` instead of the merchant and the amount.
    const query = buildRecallQuery('', evidence('bill.pdf: Blackwater Bay Water annual bill, €42.00 due'));
    expect(query).toBe('bill.pdf: Blackwater Bay Water annual bill, €42.00 due');
    expect(query).not.toContain('<');
  });

  it('combines the caption and the gist when both exist', () => {
    const query = buildRecallQuery(
      'is this the same as last year?',
      evidence('bill.pdf: Blackwater Bay Water, €42.00'),
    );
    expect(query).toContain('is this the same as last year?');
    expect(query).toContain('Blackwater Bay Water');
  });

  it('clips a long query, since a long one dilutes query expansion', () => {
    expect(buildRecallQuery('x'.repeat(500), evidence('y'.repeat(500))).length).toBeLessThanOrEqual(600);
  });
});

describe('mergeStreamedToolName', () => {
  it('concatenates true deltas', () => {
    expect(mergeStreamedToolName('', 'list_')).toBe('list_');
    expect(mergeStreamedToolName('list_', 'calendar_')).toBe('list_calendar_');
    expect(mergeStreamedToolName('list_calendar_', 'events')).toBe('list_calendar_events');
  });

  it('ignores an exact full-name re-send', () => {
    expect(mergeStreamedToolName('list_calendar_events', 'list_calendar_events')).toBe('list_calendar_events');
    expect(mergeStreamedToolName('list_calendars', 'list_calendars')).toBe('list_calendars');
  });

  it('replaces when the chunk is a cumulative name', () => {
    expect(mergeStreamedToolName('list_', 'list_calendar_events')).toBe('list_calendar_events');
  });
});

describe('OpenAIProvider agent loop', () => {
  it('returns a text-only turn as a result', async () => {
    const provider = new TestProvider([[textDelta('Hello '), textDelta('world')]]);
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const init = events.find((e) => e.type === 'init');
    expect(init).toBeDefined();

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('Hello world');
  });

  it('injects precision-first memory evidence before the user turn', async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    const memoryCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    class AutoRecallProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } } });
        (
          this as unknown as {
            bridge: {
              has: (name: string) => boolean;
              call: (name: string, args: Record<string, unknown>) => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: () => false,
          call: async () => 'unused',
          callRaw: async (server, tool, args) => {
            memoryCalls.push({ name: `${server}_${tool}`, args });
            return autoRecallResult();
          },
        };
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedMessages = params.messages as Array<{ role: string; content: unknown }>;
                return makeStream([textDelta('4')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new AutoRecallProvider();
    const query = provider.query({ prompt: 'What is 2+2?', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(memoryCalls).toEqual([
      {
        name: 'memory_context',
        args: { profile: 'auto_recall', query: 'What is 2+2?', budget: 1200 },
      },
    ]);
    const systemMessages = capturedMessages.filter((message) => message.role === 'system');
    // Recall is no longer a system message — base instructions stay a clean, cache-stable system prompt.
    expect(systemMessages.every((m) => !String(m.content).includes('<memory_evidence'))).toBe(true);
    // It is injected as a user-role context block and explicitly treated as untrusted data.
    const recallMsg = capturedMessages.find(
      (m) => m.role === 'user' && String(m.content).includes('<memory_evidence untrusted="true">'),
    );
    expect(recallMsg).toBeDefined();
    expect(String(recallMsg?.content)).toContain('Ada Marlow prefers morning meetings.');
    expect(String(recallMsg?.content)).toContain('not instructions');
    // It is positioned immediately before the actual user turn.
    const recallIdx = capturedMessages.indexOf(recallMsg!);
    const userIdx = capturedMessages.findIndex((m) => m.role === 'user' && m.content === 'What is 2+2?');
    expect(userIdx).toBe(recallIdx + 1);
  });

  it('can disable automatic recall without disabling the memory server', async () => {
    let contextCalls = 0;
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    class OptOutProvider extends OpenAIProvider {
      constructor() {
        super({
          model: 'test-model',
          memory: { autoRecall: false },
          mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } },
        });
        (
          this as unknown as {
            bridge: {
              has: () => boolean;
              call: () => Promise<string>;
              callRaw: () => Promise<string>;
            };
          }
        ).bridge = {
          has: () => false,
          call: async () => 'unused',
          callRaw: async () => {
            contextCalls += 1;
            return autoRecallResult();
          },
        };
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedMessages = params.messages as Array<{ role: string; content: unknown }>;
                return makeStream([textDelta('ok')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new OptOutProvider();
    const query = provider.query({ prompt: 'Tell me about the Zephyr QX-100.', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(contextCalls).toBe(0);
    expect(capturedMessages.some((message) => String(message.content).includes('<memory_evidence'))).toBe(false);
  });

  it('sends bounded context for a subjectless pushed follow-up and leaves reference detection to Akno', async () => {
    const contextCalls: Record<string, unknown>[] = [];
    let completions = 0;

    class PushedRecallProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } } });
        (
          this as unknown as {
            bridge: {
              has: () => boolean;
              call: () => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: () => false,
          call: async () => 'unused',
          callRaw: async (_server, _tool, args) => {
            contextCalls.push(args);
            return autoRecallResult(
              "Ada Marlow's current international credential code is 2222.",
              Array.isArray(args.conversation_context) ? 'resolved' : 'not_needed',
            );
          },
        };
        this.client = {
          chat: {
            completions: {
              create: async () => {
                completions += 1;
                return makeStream([
                  textDelta(
                    completions === 1
                      ? "Ada Marlow's membership number is 1111."
                      : "Ada Marlow's current credential code is 2222.",
                  ),
                ]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new PushedRecallProvider();
    const query = provider.query({ prompt: "What is Ada Marlow's membership number?", cwd: agentDir });
    let results = 0;
    for await (const event of query.events) {
      if (event.type !== 'result') continue;
      results += 1;
      if (results === 1) query.push('Current credential code (international)?');
      else query.end();
    }

    expect(contextCalls).toHaveLength(2);
    expect(contextCalls[0]).toEqual({
      profile: 'auto_recall',
      query: "What is Ada Marlow's membership number?",
      budget: 1200,
    });
    expect(contextCalls[1]).toEqual({
      profile: 'auto_recall',
      query: 'Current credential code (international)?',
      budget: 1200,
      conversation_context: [
        { role: 'user', content: "What is Ada Marlow's membership number?" },
        { role: 'assistant', content: "Ada Marlow's membership number is 1111." },
      ],
    });
  });

  it('recalls on the unwrapped message plus the attachment gist, never the XML envelope', async () => {
    // Regression: `topicText` is empty for a caption-less attachment, so the
    // fallback handed the whole XML envelope to both the topic classifier and
    // the recall query — memory embedded `<context timezone=…>` and the topic
    // stayed on whatever came before.
    const memoryCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    class EnvelopeProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } } });
        (
          this as unknown as {
            bridge: {
              has: (n: string) => boolean;
              call: (n: string, a: Record<string, unknown>) => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: () => false,
          call: async () => 'unused',
          callRaw: async (server, tool, args) => {
            memoryCalls.push({ name: `${server}_${tool}`, args });
            return autoRecallResult('The annual bill is recorded.');
          },
        };
        this.client = {
          chat: { completions: { create: async () => makeStream([textDelta('filed')]) } },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const envelope =
      '<context timezone="Europe/London" />\n' +
      '<message id="42" from="telegram" sender="Ada" time="11:20">' +
      '[document: 123456789.pdf — saved to /workspace/inbox/m-42/123456789.pdf]</message>';

    const provider = new EnvelopeProvider();
    const query = provider.query({
      prompt: envelope,
      // Empty, exactly as `extractUserText` returns for a caption-less file.
      topicText: '',
      attachments: {
        count: 1,
        imageCount: 0,
        documentCount: 1,
        gist: '123456789.pdf: Blackwater Bay Water annual bill, €42.00 due, invoice INV-0001',
        titleHint: 'Blackwater Bay Water invoice',
      },
      episodesEnabled: true,
      cwd: agentDir,
    });
    query.end();
    await collect(query.events);

    expect(memoryCalls).toHaveLength(1);
    const recalled = String(memoryCalls[0]!.args.query);
    expect(recalled).toContain('Blackwater Bay Water annual bill');
    expect(recalled).not.toContain('<context');
    expect(recalled).not.toContain('<message');
    expect(recalled).not.toContain('/workspace/inbox');
  });

  it('injects calendar and reminders agenda once in parallel with recall and persists them in history', async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    const toolCalls: string[] = [];
    const toolArgs: Array<{ name: string; args: Record<string, unknown> }> = [];
    let turn = 0;

    class CalendarRecallProvider extends OpenAIProvider {
      constructor() {
        super({
          model: 'test-model',
          apple: { defaultCalendar: 'Household', defaultRemindersList: 'Household' },
          mcpServers: {
            memory: { command: 'bun', args: ['mcp-http-relay.ts'] },
            apple_calendar: { command: 'relay', args: [] },
            apple_reminders: { command: 'relay', args: [] },
          },
        });
        (
          this as unknown as {
            bridge: {
              has: (name: string) => boolean;
              call: (name: string, args: Record<string, unknown>) => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: (name) => name === 'list_calendar_events' || name === 'list_reminders',
          call: async (name, args) => {
            toolCalls.push(name);
            toolArgs.push({ name, args });
            if (name === 'list_calendar_events') {
              return JSON.stringify([
                {
                  summary: 'Standup',
                  startDate: '2026-07-23T09:00:00',
                  endDate: '2026-07-23T09:30:00',
                  calendar: 'Household',
                  uid: 'uid-standup',
                },
              ]);
            }
            if (name === 'list_reminders') {
              return JSON.stringify([{ name: 'Buy milk', id: 'rem-1', completed: false }]);
            }
            return 'Prefers morning meetings.';
          },
          callRaw: async (server, tool, args) => {
            const name = `${server}_${tool}`;
            toolCalls.push(name);
            toolArgs.push({ name, args });
            return autoRecallResult();
          },
        };
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedMessages = params.messages as Array<{ role: string; content: unknown }>;
                turn += 1;
                return makeStream([textDelta(turn === 1 ? 'ok' : 'tomorrow')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new CalendarRecallProvider();
    const query = provider.query({ prompt: 'What is on my calendar?', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const continuation = init.continuation;

    expect(toolCalls).toContain('list_calendar_events');
    expect(toolCalls).toContain('list_reminders');
    expect(toolCalls).toContain('memory_context');
    expect(toolArgs.find((c) => c.name === 'list_calendar_events')?.args).toEqual(
      expect.objectContaining({
        from_date: expect.any(String),
        to_date: expect.any(String),
      }),
    );
    expect(toolArgs.find((c) => c.name === 'list_calendar_events')?.args.calendar).toBeUndefined();
    expect(toolArgs.find((c) => c.name === 'list_reminders')?.args).toEqual({
      include_completed: false,
    });
    const systemMessages = capturedMessages.filter((m) => m.role === 'system');
    // Agenda is persisted in history only — not duplicated into the memory addon.
    expect(systemMessages.some((m) => String(m.content).includes('<calendar-agenda'))).toBe(false);
    expect(systemMessages.some((m) => String(m.content).includes('<reminders-agenda'))).toBe(false);
    // Recall is a user-role context block, not a system message.
    expect(systemMessages.some((m) => String(m.content).includes('<memory_evidence'))).toBe(false);
    expect(capturedMessages.some((m) => m.role === 'user' && String(m.content).includes('<memory_evidence'))).toBe(
      true,
    );
    expect(
      capturedMessages.some(
        (m) =>
          m.role === 'user' &&
          String(m.content).includes('<calendar-agenda') &&
          String(m.content).includes('calendar="Household"') &&
          String(m.content).includes('id:uid-standup'),
      ),
    ).toBe(true);
    expect(
      capturedMessages.some(
        (m) =>
          m.role === 'user' &&
          String(m.content).includes('<reminders-agenda') &&
          String(m.content).includes('Buy milk') &&
          String(m.content).includes('id:rem-1'),
      ),
    ).toBe(true);

    expect(continuation).toBeTruthy();
    const history = loadHistory(continuation);
    expect(history?.some((m) => typeof m.content === 'string' && m.content.includes('<calendar-agenda'))).toBe(true);
    expect(history?.some((m) => typeof m.content === 'string' && m.content.includes('<reminders-agenda'))).toBe(true);

    // Second turn: no re-fetch of calendar/reminders.
    toolCalls.length = 0;
    const follow = provider.query({
      prompt: 'And tomorrow?',
      cwd: agentDir,
      continuation,
    });
    follow.end();
    await collect(follow.events);

    expect(toolCalls).not.toContain('list_calendar_events');
    expect(toolCalls).not.toContain('list_reminders');
    expect(toolCalls).toContain('memory_context');
  });

  it('persists empty calendar/reminders sentinels so later turns do not re-fetch', async () => {
    const toolCalls: string[] = [];
    let turn = 0;

    class EmptyCalendarProvider extends OpenAIProvider {
      constructor() {
        super({
          model: 'test-model',
          apple: { defaultCalendar: 'Household', defaultRemindersList: 'Household' },
          mcpServers: {
            memory: { command: 'memory', args: ['serve'] },
            apple_calendar: { command: 'relay', args: [] },
            apple_reminders: { command: 'relay', args: [] },
          },
        });
        (
          this as unknown as {
            bridge: {
              has: (name: string) => boolean;
              call: (name: string, args: Record<string, unknown>) => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: (name) => name === 'memory_recall' || name === 'list_calendar_events' || name === 'list_reminders',
          call: async (name) => {
            toolCalls.push(name);
            if (name === 'list_calendar_events' || name === 'list_reminders') return '[]';
            return 'A fact.';
          },
          callRaw: async () => autoRecallResult(),
        };
        this.client = {
          chat: {
            completions: {
              create: async () => {
                turn += 1;
                return makeStream([textDelta(turn === 1 ? 'ok' : 'again')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new EmptyCalendarProvider();
    const query = provider.query({ prompt: 'Anything on my calendar?', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;

    expect(toolCalls.filter((n) => n === 'list_calendar_events')).toHaveLength(1);
    expect(toolCalls.filter((n) => n === 'list_reminders')).toHaveLength(1);
    const history = loadHistory(init.continuation);
    expect(history?.some((m) => typeof m.content === 'string' && m.content.includes('(no events)'))).toBe(true);
    expect(history?.some((m) => typeof m.content === 'string' && m.content.includes('(no reminders)'))).toBe(true);

    toolCalls.length = 0;
    const follow = provider.query({
      prompt: 'What about next week planning?',
      cwd: agentDir,
      continuation: init.continuation,
    });
    follow.end();
    await collect(follow.events);
    expect(toolCalls).not.toContain('list_calendar_events');
    expect(toolCalls).not.toContain('list_reminders');
  });

  it('skips calendar injection when calendar MCP tool is missing', async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = [];

    class NoCalendarProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: { memory: { command: 'bun', args: ['mcp-http-relay.ts'] } } });
        (
          this as unknown as {
            bridge: {
              has: (name: string) => boolean;
              call: (name: string, args: Record<string, unknown>) => Promise<string>;
              callRaw: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>;
            };
          }
        ).bridge = {
          has: () => false,
          call: async () => 'unused',
          callRaw: async () => autoRecallResult(),
        };
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedMessages = params.messages as Array<{ role: string; content: unknown }>;
                return makeStream([textDelta('ok')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }

      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new NoCalendarProvider();
    const query = provider.query({ prompt: 'What is on my calendar?', cwd: agentDir });
    query.end();
    await collect(query.events);

    const allContent = capturedMessages.map((m) => String(m.content ?? '')).join('\n');
    expect(allContent).not.toContain('<calendar-agenda');
    expect(allContent).toContain('<memory_evidence');
  });

  it('emits phase:thinking on first SSE chunk and phase:generating on first text delta', async () => {
    const provider = new TestProvider([[textDelta('Hello'), textDelta(' world')]]);
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const phaseEvents = events.filter((e) => e.type === 'phase') as Extract<ProviderEvent, { type: 'phase' }>[];
    const thinking = phaseEvents.find((e) => e.phase === 'thinking');
    const generating = phaseEvents.find((e) => e.phase === 'generating');

    expect(thinking).toBeDefined();
    expect(generating).toBeDefined();
    expect(generating?.text).toBeTruthy();

    // thinking must come before generating in the event stream
    const thinkingIdx = events.indexOf(thinking!);
    const generatingIdx = events.indexOf(generating!);
    expect(thinkingIdx).toBeLessThan(generatingIdx);
  });

  it('re-emits phase:thinking while reasoning_content streams (keeps heartbeat alive)', async () => {
    // Simulate a hybrid reasoning model: many reasoning chunks before any
    // content. We must keep yielding thinking phases so the poll loop keeps
    // touching the heartbeat and the host sweep does not reap the container.
    const chunks = [...Array.from({ length: 5 }, (_, i) => reasoningDelta(`step ${i} `)), textDelta('42')];
    const provider = new TestProvider([chunks]);
    const query = provider.query({ prompt: 'think then answer', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const thinking = events.filter((e) => e.type === 'phase' && e.phase === 'thinking');
    // At least the initial thinking; reasoning-driven ones are throttled but the
    // final generating text must still land.
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('42');
  });

  it('sends the configured none effort on the first GPT-6 Luna tool request', async () => {
    const provider = new EffortRejectProvider([[textDelta('ready')]], { model: 'gpt-6-luna', effort: 'none' });
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    expect((events.find((e) => e.type === 'result') as { text?: string }).text).toBe('ready');
    expect(provider.seenEfforts).toEqual(['none']);
  });

  it('drops reasoning_effort rather than suppressing reasoning when the endpoint just refuses the field', async () => {
    // "You may not SET how hard to think" is not "you may not think". An endpoint
    // that refuses the parameter without naming a remedy gets the field dropped,
    // so the model keeps its own reasoning default — forcing 'none' here made
    // every later turn measurably dumber for no reason.
    const provider = new GenericEffortRejectProvider([[textDelta('recovered')], [textDelta('again')]], 'omitted', {
      effort: 'high',
    });
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect((events.find((e) => e.type === 'result') as { text?: string }).text).toBe('recovered');
    // Configured effort tried once, then the field is simply gone — never 'none'.
    expect(provider.seenEfforts).toEqual(['high', 'absent']);

    // Later turns skip the doomed attempt and still never send 'none'.
    const q2 = provider.query({ prompt: 'again', cwd: agentDir });
    q2.end();
    await collect(q2.events);
    expect(provider.seenEfforts).toEqual(['high', 'absent', 'absent']);
    expect(provider.seenEfforts).not.toContain('none');
  });

  it('escalates to reasoning_effort="none" only once dropping the field is also refused', async () => {
    // A gateway that insists on the explicit value without saying so: omit is
    // tried first, fails, and only then does 'none' get sent.
    const provider = new GenericEffortRejectProvider([[textDelta('recovered')], [textDelta('again')]], 'none-only', {
      effort: 'high',
    });
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect((events.find((e) => e.type === 'result') as { text?: string }).text).toBe('recovered');
    expect(provider.seenEfforts).toEqual(['high', 'absent', 'none']);

    // Both doomed attempts are skipped from here on.
    const q2 = provider.query({ prompt: 'again', cwd: agentDir });
    q2.end();
    await collect(q2.events);
    expect(provider.seenEfforts).toEqual(['high', 'absent', 'none', 'none']);
  });

  it('goes straight to "none" when effort was never sent — there is no field to drop', async () => {
    // agent.effort unset is the default, so `omit` would be a no-op and the retry
    // wasted. Only the useful escalation is attempted.
    const provider = new GenericEffortRejectProvider([[textDelta('ok')]], 'none-only');
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(provider.seenEfforts).toEqual(['absent', 'none']);
  });

  it('retries with reasoning_effort="none" when tools+effort are rejected, then sticks with it', async () => {
    // Regression: switching to a gpt-5.x model that forbids reasoning_effort
    // alongside function tools (e.g. gpt-5.6-luna) must not fail the turn — it
    // should transparently fall back to 'none' and remember for later turns.
    // That gateway names 'none' in the error, so it is reached in one step
    // without the intermediate omit probe.
    const provider = new EffortRejectProvider([[textDelta('recovered')], [textDelta('again')]], {
      effort: 'high',
    });
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('recovered');
    // First attempt used the configured effort (rejected), retry used 'none'.
    expect(provider.seenEfforts).toEqual(['high', 'none']);

    // A subsequent turn skips the doomed 'high' attempt entirely — it never
    // sends the configured effort again for this session.
    const q2 = provider.query({ prompt: 'again', cwd: agentDir });
    q2.end();
    await collect(q2.events);
    expect(provider.seenEfforts.filter((e) => e === 'high')).toHaveLength(1);
    expect(provider.seenEfforts.slice(1).every((e) => e === 'none')).toBe(true);
  });

  it('retries with reasoning_effort="none" when effort is unset and the gateway defaults it', async () => {
    // Real install config often leaves agent.effort null. Gateways like
    // gpt-5.6-luna still apply a non-none default and 400 with tools — so we
    // must retry with an explicit 'none' even when we never sent the field.
    const provider = new EffortRejectProvider([[textDelta('ok')], [textDelta('again')]]);
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('ok');
    expect(provider.seenEfforts).toEqual([undefined, 'none']);

    const q2 = provider.query({ prompt: 'again', cwd: agentDir });
    q2.end();
    await collect(q2.events);
    expect(provider.seenEfforts.filter((e) => e === undefined)).toHaveLength(1);
    expect(provider.seenEfforts.slice(1).every((e) => e === 'none')).toBe(true);
  });

  it('emits phase:thinking after a tool call so the status leaves the tool step', async () => {
    // Regression: after a tool call the follow-up completion used to emit no
    // thinking phase until its first token, so the live card froze on the tool
    // (e.g. "Skill…") for the whole reasoning phase. We now flip to Thinking as
    // soon as the next model round-trip starts.
    const provider = new TestProvider([[toolCallDelta('call_1', 'TestTool', '{}')], [textDelta('answer')]]);
    const query = provider.query({ prompt: 'use tool', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const toolIdx = events.findIndex((e) => e.type === 'tool');
    expect(toolIdx).toBeGreaterThan(-1);
    const thinkingAfterTool = events.slice(toolIdx + 1).some((e) => e.type === 'phase' && e.phase === 'thinking');
    expect(thinkingAfterTool).toBe(true);
  });

  it('merges OPENAI_EXTRA_BODY into the completion request', async () => {
    process.env.OPENAI_EXTRA_BODY = JSON.stringify({ chat_template_kwargs: { enable_thinking: false } });
    try {
      let captured: Record<string, unknown> = {};
      class CaptureProvider extends OpenAIProvider {
        constructor() {
          super({ model: 'test-model', mcpServers: {} });
          this.client = {
            chat: {
              completions: {
                create: async (params: Record<string, unknown>) => {
                  captured = params;
                  return makeStream([textDelta('ok')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
        protected async ensureTools(): Promise<OpenAITool[]> {
          return [];
        }
      }

      const provider = new CaptureProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir });
      query.end();
      await collect(query.events);

      expect(captured.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      delete process.env.OPENAI_EXTRA_BODY;
    }
  });

  it('uses non-stream path when extraBody sets stream:false and records cached tokens', async () => {
    process.env.OPENAI_EXTRA_BODY = JSON.stringify({ stream: false });
    try {
      let captured: Record<string, unknown> = {};
      class NonStreamProvider extends OpenAIProvider {
        constructor() {
          super({ model: 'test-model', mcpServers: {} });
          this.client = {
            chat: {
              completions: {
                create: async (params: Record<string, unknown>) => {
                  captured = params;
                  expect(params.stream).toBe(false);
                  return {
                    choices: [
                      {
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'cached-ok' },
                      },
                    ],
                    usage: {
                      prompt_tokens: 2000,
                      completion_tokens: 3,
                      prompt_tokens_details: { cached_tokens: 1500 },
                    },
                    provider: 'OpenAI',
                  };
                },
              },
            },
          } as ChatCompletionsClient;
        }
        protected async ensureTools(): Promise<OpenAITool[]> {
          return [];
        }
      }

      const provider = new NonStreamProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir });
      query.end();
      const events = await collect(query.events);
      expect(captured.stream).toBe(false);
      expect(events.some((e) => e.type === 'result' && e.text === 'cached-ok')).toBe(true);
      const recorded = (getSessionClient() as InMemorySessionClient).usage;
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.cachedTokens).toBe(1500);
      expect(recorded[0]?.cachedTokensKnown).toBe(true);
    } finally {
      delete process.env.OPENAI_EXTRA_BODY;
    }
  });

  it('escalates effort the same way on the non-stream path, and gives up rather than looping', async () => {
    process.env.OPENAI_EXTRA_BODY = JSON.stringify({ stream: false });
    try {
      const seen: Array<string | 'absent'> = [];
      class NonStreamRejectProvider extends OpenAIProvider {
        constructor() {
          super({ model: 'gpt-5-mini', effort: 'high', mcpServers: {} });
          this.client = {
            chat: {
              completions: {
                create: async (params: Record<string, unknown>) => {
                  const has = 'reasoning_effort' in params;
                  seen.push(has ? String(params.reasoning_effort) : 'absent');
                  // Refuses everything, including 'none' — the escalation has to
                  // terminate on its own rather than retry forever.
                  throw new Error('400 Function tools with reasoning_effort are not supported for this model.');
                },
              },
            },
          } as unknown as ChatCompletionsClient;
        }
        protected async ensureTools(): Promise<OpenAITool[]> {
          return [
            {
              type: 'function',
              function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
            },
          ];
        }
      }

      const provider = new NonStreamRejectProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir });
      query.end();
      await collect(query.events);

      // default → omit → none, then stop. The turn reports the failure instead.
      expect(seen).toEqual(['high', 'absent', 'none']);
    } finally {
      delete process.env.OPENAI_EXTRA_BODY;
    }
  });

  it('emits phase:thinking but not phase:generating when response is pure tool calls', async () => {
    const provider = new TestProvider([[toolCallDelta('call_1', 'TestTool', '{}')], [textDelta('result')]]);
    const query = provider.query({ prompt: 'use tool', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const phaseEvents = events.filter((e) => e.type === 'phase') as Extract<ProviderEvent, { type: 'phase' }>[];
    const firstComposeIdx = events.findIndex((e) => e.type === 'tool_compose');
    expect(firstComposeIdx).toBeGreaterThan(-1);
    const generatingBeforeCompose = events
      .slice(0, firstComposeIdx)
      .filter((e) => e.type === 'phase' && e.phase === 'generating');
    expect(phaseEvents.some((e) => e.phase === 'thinking')).toBe(true);
    expect(generatingBeforeCompose).toHaveLength(0);
  });

  it('emits tool_compose before stream ends on pure tool stream', async () => {
    const provider = new TestProvider([[toolCallDelta('call_1', 'search_memory', '{}')]]);
    const query = provider.query({ prompt: 'search', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const compose = events.filter((e) => e.type === 'tool_compose');
    expect(compose.length).toBeGreaterThan(0);
    expect((compose[0] as Extract<ProviderEvent, { type: 'tool_compose' }>).name).toContain('search_memory');
  });

  it('does not double tool names when the stream re-sends the full name', async () => {
    // Regression: Blackbox (and similar proxies) re-send the complete function.name
    // on a later chunk. Naive += produced list_calendar_eventslist_calendar_events
    // and dispatch failed with "Unknown tool".
    const provider = new TestProvider([
      [
        toolCallDelta('call_1', 'list_calendar_events', ''),
        toolCallDelta('call_1', 'list_calendar_events', '{"mode":"range"}'),
      ],
      [textDelta('ok')],
    ]);
    const query = provider.query({ prompt: 'plans', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(provider.dispatched).toEqual([{ name: 'list_calendar_events', args: { mode: 'range' } }]);
  });

  it('executes every call in a batch and pairs each with its own result', async () => {
    const provider = new TestProvider([
      [
        indexedToolCallDelta(0, 'call_a', 'TestTool', '{"q":"one"}'),
        indexedToolCallDelta(1, 'call_b', 'TestTool', '{"q":"two"}'),
        indexedToolCallDelta(2, 'call_c', 'TestTool', '{"q":"three"}'),
      ],
      [textDelta('all three done')],
    ]);
    const query = provider.query({ prompt: 'look three things up', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched.map((d) => d.args)).toEqual([{ q: 'one' }, { q: 'two' }, { q: 'three' }]);
    // Each call gets its own `tool` event, indexed by batch position.
    expect(events.filter((e) => e.type === 'tool').map((e) => (e as { index?: number }).index)).toEqual([0, 1, 2]);

    // OpenAI requires every tool_call to be answered by a tool message.
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const history = loadHistory(init.continuation) ?? [];
    const assistant = history.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistant?.tool_calls).toHaveLength(3);
    const toolIds = history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(toolIds).toEqual(['call_a', 'call_b', 'call_c']);
  });

  it('splits a batch by id when the endpoint reuses index 0 for every call', async () => {
    // Regression: `tc.index ?? 0` merged the batch into one slot — names
    // concatenated to `TestToolTestTool` and arguments to `{"q":"one"}{"q":"two"}`,
    // which failed JSON.parse and dispatched a single call with empty args.
    const provider = new TestProvider([
      [
        unindexedToolCallDelta('call_a', 'TestTool', '', 0),
        unindexedToolCallDelta('call_a', '', '{"q":"one"}', 0),
        unindexedToolCallDelta('call_b', 'TestTool', '', 0),
        unindexedToolCallDelta('call_b', '', '{"q":"two"}', 0),
      ],
      [textDelta('both done')],
    ]);
    const query = provider.query({ prompt: 'two things', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(provider.dispatched).toEqual([
      { name: 'TestTool', args: { q: 'one' } },
      { name: 'TestTool', args: { q: 'two' } },
    ]);
  });

  it('splits a batch by id when the endpoint sends no index at all', async () => {
    const provider = new TestProvider([
      [
        unindexedToolCallDelta('call_a', 'TestTool', '{"q":'),
        unindexedToolCallDelta('call_a', '', '"one"}'),
        unindexedToolCallDelta('call_b', 'TestTool', '{"q":'),
        unindexedToolCallDelta('call_b', '', '"two"}'),
      ],
      [textDelta('both done')],
    ]);
    const query = provider.query({ prompt: 'two things', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(provider.dispatched).toEqual([
      { name: 'TestTool', args: { q: 'one' } },
      { name: 'TestTool', args: { q: 'two' } },
    ]);
  });

  it('still answers every call when one throws mid-batch', async () => {
    // A throw escaping the batch used to leave history holding an assistant
    // message with N tool_calls and fewer than N results — persisted, so the
    // next request 400s on OpenAI's pairing rule.
    const provider = new TestProvider(
      [
        [
          indexedToolCallDelta(0, 'call_a', 'TestTool', '{"n":1}'),
          indexedToolCallDelta(1, 'call_b', 'BoomTool', '{}'),
          indexedToolCallDelta(2, 'call_c', 'TestTool', '{"n":3}'),
        ],
        [textDelta('recovered')],
      ],
      (name) => {
        if (name === 'BoomTool') throw new Error('session api unreachable');
        return 'TOOL_RESULT';
      },
    );
    const query = provider.query({ prompt: 'three things', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched).toHaveLength(3);
    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('recovered');

    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    const history = loadHistory(init.continuation) ?? [];
    const assistant = history.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(assistant?.tool_calls?.length ?? 0);
    // The failure is reported to the model, not swallowed.
    expect(toolMsgs.some((m) => String(m.content).includes('session api unreachable'))).toBe(true);
  });

  it('indexes tool_compose per recovered call instead of collapsing onto one line', async () => {
    // The progress controller keys its status lines on this index, so a
    // hardcoded 0 made every recovered name overwrite the same row.
    const xml =
      `<tool_calls>\n<invoke name="TestTool">\n<parameter name="x">1</parameter>\n</invoke>\n` +
      `<invoke name="TestTool">\n<parameter name="x">2</parameter>\n</invoke>\n</tool_calls>`;
    const provider = new TestProvider([[textDelta(xml)], [textDelta('both recovered')]]);
    const query = provider.query({ prompt: 'do two', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched).toHaveLength(2);
    const composeIndices = events
      .filter((e) => e.type === 'tool_compose')
      .map((e) => (e as Extract<ProviderEvent, { type: 'tool_compose' }>).index);
    expect(composeIndices).toEqual([0, 1]);
  });

  it('drops a streamed slot that never received a function name', async () => {
    const provider = new TestProvider([
      [
        indexedToolCallDelta(0, 'call_a', 'TestTool', '{"q":"real"}'),
        // A stray fragment with args but no name — dispatching it would only
        // buy an "Unknown tool" round-trip.
        indexedToolCallDelta(1, 'call_b', '', '{"q":"nameless"}'),
      ],
      [textDelta('done')],
    ]);
    const query = provider.query({ prompt: 'one real call', cwd: agentDir });
    query.end();
    await collect(query.events);

    expect(provider.dispatched).toEqual([{ name: 'TestTool', args: { q: 'real' } }]);
  });

  it('emits generating with text then tool_compose when text precedes tools', async () => {
    const provider = new TestProvider([
      [textDelta('Let me check'), toolCallDelta('call_1', 'TestTool', '{}')],
      [textDelta('done after tool')],
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const composeIdx = events.findIndex((e) => e.type === 'tool_compose');
    expect(composeIdx).toBeGreaterThan(-1);
    const generatingBeforeCompose = events
      .slice(0, composeIdx)
      .filter((e): e is Extract<ProviderEvent, { type: 'phase' }> => e.type === 'phase' && e.phase === 'generating');
    expect(generatingBeforeCompose.some((e) => e.text === 'Let me check')).toBe(true);
    expect(events.some((e) => e.type === 'tool_compose' && e.name === 'TestTool')).toBe(true);
  });

  it('emits an interim event with prose written before a tool call', async () => {
    const provider = new TestProvider([
      [textDelta('Let me check that for you'), toolCallDelta('call_1', 'TestTool', '{}')],
      [textDelta('done after tool')],
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const interim = events.find((e) => e.type === 'interim') as Extract<ProviderEvent, { type: 'interim' }>;
    expect(interim).toBeDefined();
    expect(interim.text).toBe('Let me check that for you');

    // The interim event precedes the tool run…
    const interimIdx = events.indexOf(interim);
    const toolIdx = events.findIndex((e) => e.type === 'tool');
    expect(interimIdx).toBeLessThan(toolIdx);

    // …and the final answer still arrives as the result (not the interim).
    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('done after tool');
  });

  it('does not emit an interim event for a pure tool call (no preceding prose)', async () => {
    const provider = new TestProvider([[toolCallDelta('call_1', 'TestTool', '{}')], [textDelta('answer')]]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(events.some((e) => e.type === 'interim')).toBe(false);
  });

  it('does not leak a recovered text tool-call as an interim message', async () => {
    const xml = `<tool_calls>\n<invoke name="TestTool">\n<parameter name="x">42</parameter>\n</invoke>\n</tool_calls>`;
    const provider = new TestProvider([[textDelta(xml)], [textDelta('done after recovered tool')]]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    // The whole content was the tool-call XML, so there is no real prose to
    // surface — no interim event, and certainly no raw XML in one.
    expect(events.some((e) => e.type === 'interim')).toBe(false);
  });

  it('executes a tool call then continues to a final answer', async () => {
    const provider = new TestProvider([
      [toolCallDelta('call_1', 'TestTool', '{"x":1}')],
      [textDelta('done after tool')],
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched).toHaveLength(1);
    expect(provider.dispatched[0].name).toBe('TestTool');
    expect(provider.dispatched[0].args).toEqual({ x: 1 });

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('done after tool');

    // Liveness events must be emitted for the host idle timer.
    expect(events.some((e) => e.type === 'activity')).toBe(true);
    // A tool event announces the tool run (surfaced on CLI stderr).
    expect(events.some((e) => e.type === 'tool' && e.name === 'TestTool')).toBe(true);
  });

  // Models that don't populate the structured `tool_calls` field but emit the
  // call as an XML block in `delta.content` (Hermes/Qwen/Nexus-style). The
  // provider must recover the call, execute it, and never leak raw XML to the
  // user. Regression for the “corrupted Telegram message + no answer” report.
  it('recovers a text-emitted tool call instead of leaking the XML', async () => {
    const xml = `<tool_calls>\n<invoke name="TestTool">\n<parameter name="x">42</parameter>\n</invoke>\n</tool_calls>`;
    const provider = new TestProvider([[textDelta(xml)], [textDelta('done after recovered tool')]]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched).toHaveLength(1);
    expect(provider.dispatched[0].name).toBe('TestTool');
    expect(provider.dispatched[0].args).toEqual({ x: '42' });

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    // The raw XML must never reach the user — only the post-tool answer.
    expect(result.text).toBe('done after recovered tool');
    expect(result.text).not.toContain('<tool_calls>');

    // The recovered call is announced like a native tool call.
    expect(events.some((e) => e.type === 'tool' && e.name === 'TestTool')).toBe(true);
    expect(events.some((e) => e.type === 'tool_compose' && e.name === 'TestTool')).toBe(true);
  });

  // Gemma 4 on blackbox.ai emits self-closing <call:name …/> plus orphaned
  // <tool_call|> in delta.content instead of structured tool_calls. Regression
  // for the ZQX leak where the user saw raw `<tool_call|>` as the answer.
  it('recovers a Gemma 4 self-closing tool call instead of leaking tokens', async () => {
    const gemma = '<internal>\nSearching for ZQX.\n</internal><call:TestTool query="what is ZQX"/><tool_call|>';
    const provider = new TestProvider([[textDelta(gemma)], [textDelta('ZQX is a test acronym.')]]);
    const query = provider.query({ prompt: 'What is ZQX?', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    expect(provider.dispatched).toHaveLength(1);
    expect(provider.dispatched[0].name).toBe('TestTool');
    expect(provider.dispatched[0].args).toEqual({ query: 'what is ZQX' });

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('ZQX is a test acronym.');
    expect(result.text).not.toContain('<tool_call|>');
    expect(result.text).not.toContain('<internal>');

    expect(events.some((e) => e.type === 'interim')).toBe(false);
    expect(events.some((e) => e.type === 'tool' && e.name === 'TestTool')).toBe(true);
  });

  // Some OpenAI-compatible models (Qwen on DeepInfra) return empty content
  // after tool results. The loop must nudge them to actually summarize rather
  // than end the turn silently. Regression for the "agent stopped without
  // answering" report.
  it('nudges the model to summarize when it returns empty content after a tool call', async () => {
    const provider = new TestProvider([
      [toolCallDelta('call_1', 'TestTool', '{}')],
      [], // empty completion after the tool result → should trigger a nudge
      [textDelta('here is the summary')],
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('here is the summary');
  });

  // The nudge above re-sends the history it just appended to. Recording the
  // silent turn as `{content: null}` with no tool_calls made that replay a 400
  // on api.openai.com — and since the turn is persisted, the episode stayed
  // broken for every later message, not just this one. Regression for the
  // morning digest that ended in "Something went wrong while I was working on
  // that", and answered nothing afterwards.
  it('records a silent turn with string content so the nudge retry is a legal request', async () => {
    const provider = new StrictContentProvider([
      [toolCallDelta('call_1', 'TestTool', '{}')],
      [], // empty completion → nudge, replaying the message just recorded
      [textDelta('here is the summary')],
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('here is the summary');
    // The retry actually happened rather than the turn dying on the 400.
    expect(provider.requests.length).toBe(3);
    const replayed = provider.requests[2]!.filter((m) => m.role === 'assistant' && !(m.tool_calls?.length ?? 0));
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((m) => typeof m.content === 'string')).toBe(true);
  });

  // A history file written before the fix still holds the illegal message. The
  // wire-level repair is what lets those sessions answer again instead of
  // failing on every turn forever.
  it('repairs a persisted null-content assistant turn on resume', async () => {
    saveHistory('poisoned', [
      { role: 'user', content: 'morning digest' },
      { role: 'assistant', content: null },
    ]);
    const provider = new StrictContentProvider([[textDelta('on it')]]);
    const query = provider.query({ prompt: 'and the Karst order arrived', cwd: agentDir, continuation: 'poisoned' });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('on it');
  });

  it('delivers a fallback message instead of a silent empty result', async () => {
    const provider = new TestProvider([
      [toolCallDelta('call_1', 'TestTool', '{}')],
      [], // empty → nudge 1
      [], // empty → nudge 2
      [], // empty → give up
    ]);
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    // The turn must never be delivered as a silent "done" with no text.
    expect(result.text).toBeTruthy();
    expect(result.text).toContain("couldn't compose a reply");
  });

  // The reported failure: the model "answered" with send_message aimed at the
  // current conversation, which is only shown as a live progress note and is
  // erased when the bubble collapses. Crediting that as user-facing output
  // suppressed the fallback, so the turn ended on a bare "✅ Done in Ns".
  it('still falls back when the only send was a process update that leaves no message', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_message', '{"text":"here you go"}')], [], [], []],
      () => `${PROCESS_UPDATE_MARKER} Shown as a live progress note — NOT delivered as a message.`,
    );
    const query = provider.query({ prompt: 'what are these champagnes?', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toContain("couldn't compose a reply");
    expect(provider.requests).toHaveLength(4);
  });

  it('finishes after the first empty completion when a send delivered a message', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_message', '{"to":"peer","text":"hi"}')], []],
      () => 'Message sent to peer (id: 42)',
    );
    const query = provider.query({ prompt: 'tell peer hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBeNull();
    expect(provider.requests).toHaveLength(2);
    expect(
      provider.requests[1]?.some((m) => m.role === 'user' && String(m.content).includes('You produced no reply')),
    ).toBe(false);
  });

  it('falls back when the send itself failed', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_message', '{"to":"nope","text":"hi"}')], [], [], []],
      () => 'Error: unknown destination "nope"',
    );
    const query = provider.query({ prompt: 'tell nope hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toContain("couldn't compose a reply");
    expect(provider.requests).toHaveLength(4);
  });

  it('keeps recovery when a send result does not confirm delivery', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_message', '{"to":"peer","text":"hi"}')], [], [], []],
      () => 'Delivery status unknown',
    );
    const query = provider.query({ prompt: 'tell peer hi', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toContain("couldn't compose a reply");
    expect(provider.requests).toHaveLength(4);
  });

  it('recovers a later failed send even after an earlier one succeeded', async () => {
    const provider = new TestProvider(
      [
        [toolCallDelta('call_1', 'send_message', '{"to":"peer","text":"hi"}')],
        [toolCallDelta('call_2', 'send_file', '{"to":"peer","path":"report.pdf"}')],
        [],
        [textDelta('The message went through, but the file did not.')],
      ],
      (name) => (name === 'send_message' ? 'Message sent to peer (id: 42)' : 'Error: file delivery failed'),
    );
    const query = provider.query({ prompt: 'send a message and file', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('The message went through, but the file did not.');
    expect(provider.requests).toHaveLength(4);
  });

  it('finishes a scheduled run after a confirmed send and empty completion', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_message', '{"to":"owner","text":"briefing"}')], []],
      () => 'Message sent to owner (id: 7)',
    );
    const query = provider.query({
      prompt: 'daily briefing',
      cwd: agentDir,
      taskRun: { seriesId: 'series-1', runId: 'run-1', scheduledFor: '2026-09-25T08:00:00Z' },
    });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBeNull();
    expect(provider.requests).toHaveLength(2);
  });

  it('treats a confirmed file send as a visible reply', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'send_file', '{"to":"owner","path":"report.pdf"}')], []],
      () => 'File sent to owner (id: msg-42, filename: report.pdf)',
    );
    const query = provider.query({ prompt: 'send the report', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBeNull();
    expect(provider.requests).toHaveLength(2);
  });

  // MiniMax-M3 on DeepInfra streams its chain-of-thought via `reasoning_content`
  // but leaks the closing `</mm:think>` boundary into `content`. That stray tag
  // must never reach the user.
  it('strips leaked reasoning tags from the delivered answer', async () => {
    const provider = new TestProvider([[textDelta('</mm:think>'), textDelta('The weather in Paris is sunny.')]]);
    const query = provider.query({ prompt: 'weather?', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('The weather in Paris is sunny.');
    expect(result.text).not.toContain('mm:think');
  });

  // Reasoning models can burn the whole output budget thinking and return empty
  // `content` (finish_reason "length") on the very first turn — before any tool
  // call. The loop must still nudge them to answer instead of giving up.
  it('nudges when a reasoning model streams only reasoning_content and no answer', async () => {
    const provider = new TestProvider([
      [reasoningDelta('thinking very hard about this'), finishChunk('length')],
      [textDelta('Here is the plan.')],
    ]);
    const query = provider.query({ prompt: 'plan a trip', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('Here is the plan.');
  });

  it('stays silent when the agent already replied via send_message (no double-post)', async () => {
    const provider = new TestProvider(
      [[toolCallDelta('call_1', 'mcp__luna__send_message', '{"to":"owner","text":"hi"}')], []],
      () => 'Message sent to owner (id: 42)',
    );
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBeNull();
    expect(provider.requests).toHaveLength(2);
  });

  it('answers input steered in during the empty completion after a successful send', async () => {
    const provider = new TestProvider(
      [
        [toolCallDelta('call_1', 'send_message', '{"to":"peer","text":"hi"}')],
        [],
        [], // new input is unanswered; it must still get the empty-answer nudge
        [textDelta('I handled the new request.')],
      ],
      () => 'Message sent to peer (id: 42)',
    );
    const query = provider.query({ prompt: 'tell peer hi', cwd: agentDir });
    query.end();
    const events: ProviderEvent[] = [];
    let thinking = 0;
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'phase' && event.phase === 'thinking' && ++thinking === 2) {
        query.push('also answer this new request');
      }
    }

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('I handled the new request.');
    expect(provider.requests).toHaveLength(4);
    expect(
      provider.requests[2]?.some(
        (m) => m.role === 'user' && String(m.content).includes('also answer this new request'),
      ),
    ).toBe(true);
  });

  it('keeps a reply obligation for input steered in during the successful send', async () => {
    let queryRef: ReturnType<TestProvider['query']> | undefined;
    const provider = new TestProvider(
      [
        [toolCallDelta('call_1', 'send_message', '{"to":"peer","text":"hi"}')],
        [], // the new input needs recovery despite the earlier send
        [textDelta('The follow-up is done.')],
      ],
      () => {
        queryRef?.push('follow-up request');
        return 'Message sent to peer (id: 42)';
      },
    );
    const query = provider.query({ prompt: 'tell peer hi', cwd: agentDir });
    queryRef = query;
    query.end();
    const events = await collect(query.events);

    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('The follow-up is done.');
    expect(provider.requests).toHaveLength(3);
    expect(
      provider.requests[1]?.some((m) => m.role === 'user' && String(m.content).includes('follow-up request')),
    ).toBe(true);
  });

  it('emits an init continuation that resumes a stored session', async () => {
    const provider = new TestProvider([[textDelta('first')]]);
    const query = provider.query({ prompt: 'one', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;
    expect(typeof init.continuation).toBe('string');
    expect(init.continuation.length).toBeGreaterThan(0);
  });

  it('maybeRotateContinuation compacts in place when possible', async () => {
    const prevCap = process.env.OPENAI_SESSION_ROTATE_BYTES;
    process.env.OPENAI_SESSION_ROTATE_BYTES = '15000';
    try {
      const provider = new TestProvider([[textDelta('ok')]], undefined, {
        context: { summarization: 'deterministic', keepRecentTurns: 2 },
      });
      const sessionId = 'compact-test-session';
      const messages = [];
      for (let i = 0; i < 30; i++) {
        messages.push({ role: 'user' as const, content: `turn ${i} `.repeat(40) });
        messages.push({ role: 'assistant' as const, content: `reply ${i} `.repeat(40) });
      }
      saveHistory(sessionId, messages);

      const reason = await provider.maybeRotateContinuation(sessionId);
      expect(reason).toBeNull();
      expect(sessionExists(sessionId)).toBe(true);
      expect(await getContextSummary('openai')).toBeTruthy();
    } finally {
      if (prevCap === undefined) delete process.env.OPENAI_SESSION_ROTATE_BYTES;
      else process.env.OPENAI_SESSION_ROTATE_BYTES = prevCap;
    }
  });

  it('includes prompt_cache_key only when configured', async () => {
    let capturedParams: Record<string, unknown> | undefined;
    class CacheKeyProbe extends TestProvider {
      constructor() {
        super([[textDelta('hi')]], undefined, { context: { promptCacheKey: 'test-cache-key' } });
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedParams = params;
                return makeStream([[textDelta('hi')]]);
              },
            },
          },
        } as ChatCompletionsClient;
      }
    }
    const provider = new CacheKeyProbe();
    const query = provider.query({ prompt: 'hello', cwd: agentDir });
    query.end();
    await collect(query.events);
    expect(capturedParams?.prompt_cache_key).toBe('test-cache-key');
  });

  it('sends image_url content parts and strips them from persisted history', async () => {
    let capturedMessages: unknown;
    const imgPath = path.join(agentDir, 'test.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    class VisionProbe extends TestProvider {
      constructor() {
        super([[textDelta('I see the product')]]);
        this.client = {
          chat: {
            completions: {
              create: async (params: Record<string, unknown>) => {
                capturedMessages = params.messages;
                return makeStream([[textDelta('I see the product')]]);
              },
            },
          },
        } as ChatCompletionsClient;
      }
    }

    const provider = new VisionProbe();
    const query = provider.query({
      prompt: 'what is this?',
      images: [{ path: imgPath, mimeType: 'image/png' }],
      cwd: agentDir,
    });
    query.end();
    const events = await collect(query.events);
    const init = events.find((e) => e.type === 'init') as Extract<ProviderEvent, { type: 'init' }>;

    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    const userMsg = messages.find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);

    const persisted = loadHistory(init.continuation);
    const persistedUser = persisted?.find((m) => m.role === 'user');
    expect(typeof persistedUser?.content).toBe('string');
    expect(String(persistedUser?.content)).not.toContain('data:image');
  });

  it('retries connection errors with progress events then detailed final error', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    let attempts = 0;
    try {
      class FailingProvider extends TestProvider {
        constructor() {
          super([[textDelta('never')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new FailingProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(3);
      expect(attempts).toBe(4);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toContain('connection refused');
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('uses simplified final error for non-privileged senders', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    try {
      class FailingProvider extends TestProvider {
        constructor() {
          super([[textDelta('never')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new FailingProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: false });
      query.end();
      const events = await collect(query.events);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress[0]?.type === 'progress' && progress[0].message).toBe('Having trouble responding — trying again…');
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toContain('having trouble');
      expect(result.text).not.toContain('ECONNREFUSED');
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('recovers on retry without surfacing an error', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    let attempts = 0;
    try {
      class FlakyProvider extends TestProvider {
        constructor() {
          super([[textDelta('recovered')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  if (attempts < 2) {
                    throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                  }
                  return makeStream([textDelta('recovered')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new FlakyProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir });
      query.end();
      const events = await collect(query.events);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toBe('recovered');
      expect(events.some((e) => e.type === 'progress')).toBe(true);
      expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('retries rate limits using the proposed delay then recovers', async () => {
    const prevMax = process.env.LUNA_RATE_LIMIT_MAX_RETRIES;
    process.env.LUNA_RATE_LIMIT_MAX_RETRIES = '2';
    let attempts = 0;
    try {
      class RateLimitedProvider extends TestProvider {
        constructor() {
          super([[textDelta('ok')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  if (attempts < 2) {
                    throw new RateLimitError(
                      429,
                      {
                        message: 'Rate limit reached for gpt-5.6-luna on tokens per min (TPM). Please try again in 0s.',
                      },
                      undefined,
                      undefined,
                    );
                  }
                  return makeStream([textDelta('ok')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new RateLimitedProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]?.type === 'progress' && progress[0].message).toContain('Rate limited');
      expect(progress[0]?.type === 'progress' && progress[0].message).toContain('attempt 1/2');
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toBe('ok');
      expect(attempts).toBe(2);
      expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    } finally {
      if (prevMax === undefined) delete process.env.LUNA_RATE_LIMIT_MAX_RETRIES;
      else process.env.LUNA_RATE_LIMIT_MAX_RETRIES = prevMax;
    }
  });

  it('surfaces rate limit after exhausting retries', async () => {
    const prevMax = process.env.LUNA_RATE_LIMIT_MAX_RETRIES;
    process.env.LUNA_RATE_LIMIT_MAX_RETRIES = '1';
    let attempts = 0;
    try {
      class AlwaysRateLimited extends TestProvider {
        constructor() {
          super([[textDelta('never')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  throw new RateLimitError(429, { message: 'Please try again in 0s.' }, undefined, undefined);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new AlwaysRateLimited();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      expect(attempts).toBe(2);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(1);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toContain('Rate limited');
    } finally {
      if (prevMax === undefined) delete process.env.LUNA_RATE_LIMIT_MAX_RETRIES;
      else process.env.LUNA_RATE_LIMIT_MAX_RETRIES = prevMax;
    }
  });

  it('retries a 5xx upstream error then recovers', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    let attempts = 0;
    try {
      class FlakyGateway extends TestProvider {
        constructor() {
          super([[textDelta('recovered')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  if (attempts < 2) {
                    throw new APIError(
                      503,
                      { message: 'upstream connect error or disconnect/reset before headers' },
                      undefined,
                      undefined,
                    );
                  }
                  return makeStream([textDelta('recovered')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new FlakyGateway();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]?.type === 'progress' && progress[0].message).toContain('returned 503');
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result.text).toBe('recovered');
      expect(attempts).toBe(2);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  // Regression: a 5xx used to escape both the retry loop and the
  // result-yielding branch — the turn ended with no `result`, so the poll loop
  // never marked the message completed and the status card stayed on
  // "Thinking" until the host's 30-minute ceiling killed the container.
  it('closes the turn with a result after exhausting 5xx retries', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    let attempts = 0;
    try {
      class DeadGateway extends TestProvider {
        constructor() {
          super([[textDelta('never')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  throw new APIError(
                    503,
                    { message: 'upstream connect error or disconnect/reset before headers' },
                    undefined,
                    undefined,
                  );
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new DeadGateway();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      expect(attempts).toBe(4);
      expect(events.filter((e) => e.type === 'progress')).toHaveLength(3);
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      expect(result).toBeDefined();
      expect(result.text).toContain('503');
      // The failure is reported exactly once, as the terminal result. There is
      // no separate error event for the poll loop to log a second time.
      expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
      expect(events.some((e) => (e as { type: string }).type === 'error')).toBe(false);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  // A gateway that accepts the request and then goes quiet produces no error
  // and no end of stream. Before the idle watchdog the turn simply hung until
  // the host sweep killed the container.
  it('retries a stream that stalls mid-answer', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    const prevIdle = process.env.LUNA_STREAM_IDLE_TIMEOUT_MS;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    process.env.LUNA_STREAM_IDLE_TIMEOUT_MS = '30';
    let attempts = 0;
    try {
      class StallingProvider extends TestProvider {
        constructor() {
          super([[textDelta('never')]]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  if (attempts < 2) {
                    return {
                      async *[Symbol.asyncIterator]() {
                        yield textDelta('half an ans');
                        await new Promise((resolve) => setTimeout(resolve, 60_000));
                      },
                    } as AsyncIterable<unknown>;
                  }
                  return makeStream([textDelta('recovered')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new StallingProvider();
      const query = provider.query({ prompt: 'hi', cwd: agentDir, senderIsPrivileged: true });
      query.end();
      const events = await collect(query.events);
      expect(attempts).toBe(2);
      const progress = events.filter((e) => e.type === 'progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]?.type === 'progress' && progress[0].message).toContain('stopped sending');
      const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
      // The partial text from the stalled attempt is discarded, not stitched on.
      expect(result.text).toBe('recovered');
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
      if (prevIdle === undefined) delete process.env.LUNA_STREAM_IDLE_TIMEOUT_MS;
      else process.env.LUNA_STREAM_IDLE_TIMEOUT_MS = prevIdle;
    }
  });

  // The background memory agent runs through completeTurn, not the foreground
  // loop. It has no progress card, so its retries are silent — but without
  // them one blip discards the curation for a turn nobody will revisit.
  it('retries completeTurn for the background memory agent', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    let attempts = 0;
    try {
      class FlakyForSubAgent extends TestProvider {
        constructor() {
          super([]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  if (attempts < 3) {
                    throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                  }
                  return makeStream([textDelta('curated')]);
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new FlakyForSubAgent();
      const out = await provider.completeTurn([{ role: 'user', content: 'hi' }], [], new AbortController().signal);
      expect(out.text).toBe('curated');
      expect(attempts).toBe(3);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('gives up completeTurn once the retry budget is spent', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0';
    let attempts = 0;
    try {
      class DeadForSubAgent extends TestProvider {
        constructor() {
          super([]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new DeadForSubAgent();
      await expect(
        provider.completeTurn([{ role: 'user', content: 'hi' }], [], new AbortController().signal),
      ).rejects.toThrow();
      expect(attempts).toBe(3);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('stops retrying completeTurn as soon as the job is aborted', async () => {
    const prevDelays = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
    process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = '0,0,0';
    const controller = new AbortController();
    let attempts = 0;
    try {
      class AbortMidRetry extends TestProvider {
        constructor() {
          super([]);
          this.client = {
            chat: {
              completions: {
                create: async () => {
                  attempts += 1;
                  controller.abort();
                  throw new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
                },
              },
            },
          } as ChatCompletionsClient;
        }
      }
      const provider = new AbortMidRetry();
      const out = await provider.completeTurn([{ role: 'user', content: 'hi' }], [], controller.signal);
      expect(out).toEqual({ text: '', toolCalls: [] });
      expect(attempts).toBe(1);
    } finally {
      if (prevDelays === undefined) delete process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
      else process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC = prevDelays;
    }
  });

  it('reconnects MCP bridge once for missing configured MCP tool', async () => {
    const provider = new DispatchProbeProvider();
    let reconnects = 0;
    let connected = false;
    const fakeBridge = {
      has(name: string) {
        return connected && (name === 'memory_write' || name === 'mcp__memory__write');
      },
      async call() {
        return 'OK_FROM_MEMORY';
      },
      async reconnect() {
        reconnects += 1;
        connected = true;
      },
      toolSchemas() {
        return [];
      },
    };
    (provider as unknown as { bridge: unknown }).bridge = fakeBridge;
    const out = await provider.callDispatch('mcp__memory__write', { slug: 'x' });
    expect(out).toContain('OK_FROM_MEMORY');
    expect(reconnects).toBe(1);
  });

  it('refuses Skill load when required MCP servers are not connected', async () => {
    const provider = new DispatchProbeProvider();
    (provider as unknown as { bridge: { hasConnectedServer: (s: string) => boolean } }).bridge = {
      hasConnectedServer: () => false,
    };
    const prevHome = process.env.HOME;
    const skillHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mcp-gate-'));
    try {
      process.env.HOME = skillHome;
      const dir = path.join(skillHome, '.agents', 'skills', 'bank-review');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: bank-review\ndescription: x\nrequires_mcp: vulpine\n---\n\nCall mcp__vulpine__cashflow.\n',
      );
      const out = await provider.callDispatch('Skill', { name: 'bank-review' });
      expect(out.startsWith('Error:')).toBe(true);
      expect(out).toContain('vulpine');
      expect(out).toContain('not wired');
      expect(out).not.toContain('Call mcp__vulpine__cashflow');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(skillHome, { recursive: true, force: true });
    }
  });

  it('loads Skill when required MCP servers are connected', async () => {
    const provider = new DispatchProbeProvider();
    (provider as unknown as { bridge: { hasConnectedServer: (s: string) => boolean } }).bridge = {
      hasConnectedServer: (s: string) => s === 'vulpine',
    };
    const prevHome = process.env.HOME;
    const skillHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mcp-ok-'));
    try {
      process.env.HOME = skillHome;
      const dir = path.join(skillHome, '.agents', 'skills', 'bank-review');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: bank-review\ndescription: x\nrequires_mcp: vulpine\n---\n\nDetailed vulpine workflow.\n',
      );
      const out = await provider.callDispatch('Skill', { name: 'bank-review' });
      expect(out).toContain('Detailed vulpine workflow');
      expect(out.startsWith('Error:')).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(skillHome, { recursive: true, force: true });
    }
  });

  it('stops repeating an identical failing tool call after two failures', async () => {
    let dispatchCount = 0;
    let round = 0;
    class CountedFailProvider extends OpenAIProvider {
      public lastToolContents: string[] = [];
      constructor() {
        super({ model: 'test-model', mcpServers: {} });
        this.client = {
          chat: {
            completions: {
              create: async () => {
                round += 1;
                if (round <= 4) {
                  return makeStream([toolCallDelta(`call_${round}`, 'nope_tool', '{"x":1}')]);
                }
                return makeStream([textDelta('Gave up nicely.')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }
      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
      protected async dispatchTool(name: string): Promise<string> {
        dispatchCount += 1;
        return `Unknown tool: ${name}`;
      }
    }

    const provider = new CountedFailProvider();
    // Patch history push of tool results by wrapping run — instead inspect via
    // overriding nothing: 4 tool rounds → 2 real dispatches + 2 breaker replies.
    const query = provider.query({ prompt: 'do it', cwd: agentDir });
    query.end();
    const events = await collect(query.events);
    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result?.text).toBe('Gave up nicely.');
    // First two identical failures dispatch; further identical calls are short-circuited.
    expect(dispatchCount).toBe(2);
  });

  it('abort() cancels the in-flight completion via AbortSignal', async () => {
    let seenSignal: AbortSignal | undefined;
    class AbortProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: {} });
        this.client = {
          chat: {
            completions: {
              create: async (_params: unknown, options?: { signal?: AbortSignal }) => {
                seenSignal = options?.signal;
                return {
                  async *[Symbol.asyncIterator]() {
                    yield textDelta('partial ');
                    await new Promise<void>((resolve, reject) => {
                      const onAbort = () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                      };
                      if (options?.signal?.aborted) {
                        onAbort();
                        return;
                      }
                      options?.signal?.addEventListener('abort', onAbort, { once: true });
                    });
                  },
                };
              },
            },
          },
        } as ChatCompletionsClient;
      }
      protected async ensureTools(): Promise<OpenAITool[]> {
        return [];
      }
    }

    const provider = new AbortProvider();
    const query = provider.query({ prompt: 'hi', cwd: agentDir });
    const eventsPromise = collect(query.events);
    await Bun.sleep(20);
    query.abort();
    const events = await eventsPromise;
    expect(seenSignal?.aborted).toBe(true);
    expect(events.find((e) => e.type === 'result')).toBeUndefined();
  });

  it('steers a mid-tool push into history before the next completion', async () => {
    let queryRef: { push: (msg: string) => void } | null = null;
    const secondTurnUserTexts: string[] = [];
    let createCount = 0;

    class SteerProvider extends OpenAIProvider {
      constructor() {
        super({ model: 'test-model', mcpServers: {} });
        this.client = {
          chat: {
            completions: {
              create: async (params: { messages: Array<{ role: string; content: unknown }> }) => {
                createCount++;
                if (createCount === 1) {
                  return makeStream([toolCallDelta('call_1', 'TestTool', '{}'), finishChunk('tool_calls')]);
                }
                for (const m of params.messages) {
                  if (m.role === 'user' && typeof m.content === 'string') {
                    secondTurnUserTexts.push(m.content);
                  }
                }
                return makeStream([textDelta('after steer'), finishChunk('stop')]);
              },
            },
          },
        } as ChatCompletionsClient;
      }
      protected async ensureTools(): Promise<OpenAITool[]> {
        return [
          {
            type: 'function',
            function: { name: 'TestTool', description: 'test', parameters: { type: 'object', properties: {} } },
          },
        ];
      }
      protected async dispatchTool(): Promise<string> {
        queryRef?.push('<message>steer now</message>');
        return 'TOOL_OK';
      }
    }

    const provider = new SteerProvider();
    const query = provider.query({ prompt: 'start', cwd: agentDir });
    queryRef = query;
    query.end();
    const events = await collect(query.events);
    const result = events.find((e) => e.type === 'result') as Extract<ProviderEvent, { type: 'result' }>;
    expect(result.text).toBe('after steer');
    expect(createCount).toBe(2);
    expect(secondTurnUserTexts.some((t) => t.includes('steer now'))).toBe(true);
  });
});

describe('duplicate source retention', () => {
  let temp: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-retain-batch-'));
    setSessionsDirForTests(temp);
    installTestSessionClient();
  });
  afterEach(() => {
    setSessionsDirForTests(null);
    resetTestSessionClient();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  it('writes once and answers both call IDs, while allowing later independent retention', async () => {
    let writes = 0;
    const args = '{"source_slug":"resources/invented-guide","text":"Invented exact source"}';
    const provider = new TestProvider(
      [
        [
          indexedToolCallDelta(0, 'call_a', 'memory_retain', args),
          indexedToolCallDelta(1, 'call_b', 'memory_retain', args),
          finishChunk('tool_calls'),
        ],
        [toolCallDelta('call_c', 'memory_retain', args), finishChunk('tool_calls')],
        [textDelta('Saved.'), finishChunk('stop')],
      ],
      () => {
        writes++;
        return '{"status":"ok","preserved":true,"complete":true}';
      },
    );
    const query = provider.query({ prompt: 'Preserve the invented source.', cwd: temp });
    query.end();
    for await (const _event of query.events) {
      /* Drain tool loop. */
    }
    expect(writes).toBe(2);
    const secondRequest = provider.requests[1];
    const results = secondRequest.filter((message) => message.role === 'tool');
    expect(results.map((message) => message.tool_call_id)).toEqual(['call_a', 'call_b']);
    expect(results[0].content).toBe(results[1].content);
  });
});
