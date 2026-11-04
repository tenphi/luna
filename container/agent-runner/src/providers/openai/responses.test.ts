import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from './index.js';
import { responsesCompletion, responsesInput } from './responses.js';
import { loadHistory, setSessionsDirForTests } from './session-store.js';
import { installTestSessionClient, resetTestSessionClient } from '../../session/test-support.js';
import type { ProviderEvent } from '../types.js';
import type { OpenAITool } from './tools/builtin.js';

let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-responses-test-'));
  setSessionsDirForTests(temp);
  installTestSessionClient();
});
afterEach(() => {
  setSessionsDirForTests(null);
  resetTestSessionClient();
  fs.rmSync(temp, { recursive: true, force: true });
});
const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-fixture', summary: [] };
const message = (text: string, phase: string) => ({
  type: 'message',
  id: `msg_${phase}`,
  role: 'assistant',
  phase,
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = (suffix: string) => ({
  type: 'function_call',
  id: `fc_${suffix}`,
  call_id: `call_${suffix}`,
  name: 'TestTool',
  arguments: JSON.stringify({ value: suffix }),
  status: 'completed',
});
const tool: OpenAITool = {
  type: 'function',
  function: {
    name: 'TestTool',
    description: 'Synthetic lookup',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
  },
};
const completed = (output: unknown[]) => ({
  status: 'completed',
  output,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens_details: { reasoning_tokens: 30 },
  },
});
async function* stream(output: unknown[]) {
  for (const [output_index, item] of output.entries()) yield { type: 'response.output_item.added', output_index, item };
  yield { type: 'response.completed', response: completed(output) };
}

test('reasoning, phase, parallel function IDs, usage and resumed history survive the real tool loop', async () => {
  class Provider extends OpenAIProvider {
    requests: Record<string, any>[] = [];
    decisions = 0;
    calls: string[] = [];
    constructor() {
      super({
        model: 'gpt-6-luna',
        effort: 'adaptive',
        env: { OPENAI_API: 'responses', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: 'fixture' },
        memory: { autoRecall: false },
      });
      this.client = {
        post: (async () => {
          this.decisions++;
          return {
            answers: [
              {
                type: 'choice',
                name: 'effort',
                choice: 'high',
                confidence: 0.9,
                probabilities: [
                  { value: 'low', probability: 0.1 },
                  { value: 'medium', probability: 0.1 },
                  { value: 'high', probability: 0.8 },
                ],
              },
            ],
          };
        }) as any,
        chat: {
          completions: {
            create: async () => {
              throw new Error('Chat route must not be used');
            },
          },
        },
        responses: {
          create: async (params) => {
            this.requests.push(params);
            return this.requests.length === 1
              ? stream([reasoning, message('Checking sources.', 'commentary'), call('a'), call('b')])
              : stream([reasoning, message('Invented result.', 'final_answer')]);
          },
        },
      };
    }
    protected assembleSystemPrompt() {
      return 'Invented system instructions';
    }
    protected async ensureTools() {
      return [tool];
    }
    protected async dispatchTool(_name: string, args: Record<string, unknown>) {
      this.calls.push(String(args.value));
      return `result-${args.value}`;
    }
  }
  const provider = new Provider();
  const run = async (continuation?: string) => {
    const query = provider.query({ prompt: '<message>Check the invented sources.</message>', cwd: temp, continuation });
    query.end();
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    return events;
  };
  const events = await run();
  const id = events.find((event) => event.type === 'init');
  expect(id?.type).toBe('init');
  expect(provider.calls).toEqual(['a', 'b']);
  expect(
    events
      .filter((event) => event.type === 'tool_compose')
      .map((event) => (event.type === 'tool_compose' ? event.index : -1)),
  ).toEqual([0, 1]);
  expect(provider.decisions).toBe(1);
  expect(provider.requests[0].reasoning.effort).toBe('high');
  expect(provider.requests[0].store).toBe(false);
  expect(provider.requests[0].tools[0]).toMatchObject({ type: 'function', name: 'TestTool', strict: false });
  expect(provider.requests[1].input).toEqual([
    { role: 'system', content: 'Invented system instructions' },
    { role: 'user', content: '<message>Check the invented sources.</message>' },
    reasoning,
    message('Checking sources.', 'commentary'),
    call('a'),
    call('b'),
    { type: 'function_call_output', call_id: 'call_a', output: 'result-a' },
    { type: 'function_call_output', call_id: 'call_b', output: 'result-b' },
  ]);
  expect(
    loadHistory(id!.type === 'init' ? id.continuation : '')?.some((item) =>
      item.response_items?.some((output) => output.phase === 'final_answer'),
    ),
  ).toBe(true);
  await run(id!.type === 'init' ? id.continuation : undefined);
  expect(provider.decisions).toBe(2);
  expect(provider.requests[2].input.some((item: any) => item.encrypted_content === 'opaque-fixture')).toBe(true);
  expect(events.some((event) => event.type === 'result' && event.text?.includes('opaque-fixture'))).toBe(false);
});

test('legacy chat history and image inputs convert without losing tool call references', () => {
  const input = responsesInput([
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture', detail: 'low' } }],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ type: 'function', id: 'call_legacy', function: { name: 'TestTool', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_legacy', content: 'Result' },
  ]);
  expect(input[0].content).toEqual([
    { type: 'input_image', image_url: 'data:image/png;base64,fixture', detail: 'low' },
  ]);
  expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'call_legacy' });
  expect(input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_legacy' });
});

test('finalization overrides tool reopening and provider-side storage; incomplete output never becomes a tool result', async () => {
  let params: Record<string, unknown> = {};
  const client = {
    create: async (p: Record<string, unknown>) => {
      params = p;
      return completed([message('Done', 'final_answer')]);
    },
  };
  const ctrl = { signal: new AbortController().signal, isAborted: () => false };
  const options = {
    model: 'gpt-6-luna',
    messages: [],
    tools: [tool],
    effort: 'medium',
    extraBody: { stream: false, store: true, tool_choice: 'required', tools: [tool] },
    finalizing: true,
    idleMs: 1000,
    onTick: () => {},
  };
  const gen = responsesCompletion(client, options, ctrl);
  const event = await gen.next();
  expect(event.value).toEqual({ type: 'effort', effort: 'medium' });
  const result = await gen.next();
  expect(result.done).toBe(true);
  expect(params).toMatchObject({
    tools: [],
    tool_choice: 'none',
    store: false,
    include: ['reasoning.encrypted_content'],
  });
  expect((result.value as any).usage).toMatchObject({ promptTokens: 100, completionTokens: 50, cachedTokens: 20 });
  const incomplete = responsesCompletion(
    { create: async () => ({ status: 'incomplete', output: [call('a')] }) },
    options,
    ctrl,
  );
  await incomplete.next();
  await expect(incomplete.next()).rejects.toThrow('did not complete');
});

test('items streamed only as output_item.done survive an empty completed output, as the ChatGPT backend sends them', async () => {
  const items = [reasoning, message('Invented answer.', 'final_answer'), call('a')];
  async function* subscription() {
    for (const [output_index, item] of items.entries()) {
      yield { type: 'response.output_item.added', output_index, item };
      yield { type: 'response.output_item.done', output_index, item };
    }
    yield { type: 'response.completed', response: completed([]) };
  }
  const gen = responsesCompletion(
    { create: async () => subscription() },
    {
      model: 'gpt-6-luna',
      messages: [],
      tools: [tool],
      extraBody: {},
      finalizing: false,
      idleMs: 1000,
      onTick: () => {},
    },
    { signal: new AbortController().signal, isAborted: () => false },
  );
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  expect(step.value).toMatchObject({
    text: 'Invented answer.',
    toolCalls: [{ id: 'call_a', function: { name: 'TestTool', arguments: JSON.stringify({ value: 'a' }) } }],
    responseItems: items,
    reasoning: '[opaque reasoning state]',
  });
});

test('a stream ending before completed fails instead of dispatching partial calls', async () => {
  async function* partial() {
    yield { type: 'response.output_item.added', output_index: 0, item: call('a') };
  }
  const gen = responsesCompletion(
    { create: async () => partial() },
    {
      model: 'gpt-6-luna',
      messages: [],
      tools: [tool],
      extraBody: {},
      finalizing: false,
      idleMs: 1000,
      onTick: () => {},
    },
    { signal: new AbortController().signal, isAborted: () => false },
  );
  try {
    for await (const _event of gen) {
      /* Drain until completion is required. */
    }
    throw new Error('Expected failure');
  } catch (error) {
    expect(String(error)).toContain('without a completed response');
  }
});
