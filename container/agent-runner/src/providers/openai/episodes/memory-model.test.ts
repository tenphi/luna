import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { memoryChat, parseJsonObject, resetMemoryClientForTests, resolveMemoryModel } from './memory-model.js';

const NO_ENV = {} as Record<string, string | undefined>;

describe('resolveMemoryModel', () => {
  it('prefers the host-resolved memory block', () => {
    const resolved = resolveMemoryModel(
      { baseUrl: 'http://host.docker.internal:1234/v1', apiKey: 'k', chatModel: 'llama-3.2-3b-instruct' },
      { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODEL: 'gpt-4o' },
    );

    expect(resolved).toEqual({
      baseURL: 'http://host.docker.internal:1234/v1',
      apiKey: 'k',
      model: 'llama-3.2-3b-instruct',
      fromMain: false,
    });
  });

  it('falls back to the main model when no memory block is configured', () => {
    const resolved = resolveMemoryModel(undefined, {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-main',
      OPENAI_MODEL: 'gpt-4o',
    });

    expect(resolved).toEqual({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-main',
      model: 'gpt-4o',
      fromMain: true,
    });
  });

  it('treats a memory block without a chat model as absent', () => {
    const resolved = resolveMemoryModel({ baseUrl: 'http://local:1234/v1' }, {
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
    });

    expect(resolved?.model).toBe('gpt-4o');
    expect(resolved?.baseURL).toBe('https://api.openai.com/v1');
    expect(resolved?.fromMain).toBe(true);
  });

  it('substitutes a placeholder key for keyless local endpoints', () => {
    const resolved = resolveMemoryModel({ baseUrl: 'http://local:1234/v1', chatModel: 'qwen' }, NO_ENV);

    expect(resolved?.apiKey).toBe('sk-no-key-required');
  });

  it('returns null when nothing is configured', () => {
    expect(resolveMemoryModel(undefined, NO_ENV)).toBeNull();
    expect(resolveMemoryModel({ chatModel: 'qwen' }, NO_ENV)).toBeNull();
  });

  describe('summary role', () => {
    const MAIN = { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODEL: 'gpt-4o' };

    it('uses models.memory for both roles when it is set', () => {
      const memory = { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', chatModel: 'gpt-5.4-nano' };
      expect(resolveMemoryModel(memory, MAIN, 'chat')?.model).toBe('gpt-5.4-nano');
      expect(resolveMemoryModel(memory, MAIN, 'summary')?.model).toBe('gpt-5.4-nano');
    });

    it('sends summaries to the cheap endpoint and classification to main when models.memory is unset', () => {
      // What the host resolves with `models.memory` unset: no chat block, and a
      // summary block pointing at the memory endpoint's model.
      const memory = {
        summaryBaseUrl: 'http://host.docker.internal:1234/v1',
        summaryApiKey: 'local',
        summaryModel: 'llama-3.2-3b-instruct',
      };

      const chat = resolveMemoryModel(memory, MAIN, 'chat');
      expect(chat?.model).toBe('gpt-4o');
      expect(chat?.fromMain).toBe(true);

      const summary = resolveMemoryModel(memory, MAIN, 'summary');
      expect(summary?.model).toBe('llama-3.2-3b-instruct');
      expect(summary?.baseURL).toBe('http://host.docker.internal:1234/v1');
      expect(summary?.fromMain).toBe(false);
    });

    it('falls the summary role through to main when the cheap endpoint is half-configured', () => {
      expect(resolveMemoryModel({ summaryModel: 'llama' }, MAIN, 'summary')?.model).toBe('gpt-4o');
      expect(resolveMemoryModel({ summaryBaseUrl: 'http://local/v1' }, MAIN, 'summary')?.model).toBe('gpt-4o');
    });
  });
});

describe('memoryChat', () => {
  const realFetch = globalThis.fetch;
  let bodies: Record<string, unknown>[];

  function reply(content: string | null, finishReason: string, extra: Record<string, unknown> = {}): Response {
    return new Response(
      JSON.stringify({
        id: 'c1',
        choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content, ...extra } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  beforeEach(() => {
    bodies = [];
    resetMemoryClientForTests();
    process.env.OPENAI_BASE_URL = 'http://memory-model.test/v1';
    process.env.OPENAI_MODEL = 'tiny';
    process.env.OPENAI_API_KEY = 'k';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetMemoryClientForTests();
  });

  function stub(...responses: Response[]): void {
    let call = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return responses[call++] ?? responses[responses.length - 1]!;
    }) as typeof fetch;
  }

  it('retries a thinking model that spent its whole allowance before answering', async () => {
    stub(reply('', 'length', { reasoning_content: 'weighing the options…' }), reply('{"decision":"new"}', 'stop'));

    expect(await memoryChat([{ role: 'user', content: 'hi' }], { maxTokens: 80 })).toBe('{"decision":"new"}');
    expect(bodies.map((b) => b.max_tokens)).toEqual([80, 320]);
  });

  it('gives up after one widened retry rather than looping', async () => {
    stub(reply('', 'length'));

    expect(await memoryChat([{ role: 'user', content: 'hi' }], { maxTokens: 50 })).toBeNull();
    expect(bodies).toHaveLength(2);
  });

  it('asks for a non-thinking answer, and drops the ask on an endpoint that rejects it', async () => {
    const bad = () =>
      new Response(JSON.stringify({ error: "unknown parameter 'reasoning_effort'" }), { status: 400 });
    stub(bad(), reply('{"decision":"continue"}', 'stop'), reply('{"decision":"new"}', 'stop'));

    expect(await memoryChat([{ role: 'user', content: 'hi' }])).toBe('{"decision":"continue"}');
    expect(bodies[0]!.reasoning_effort).toBe('none');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');

    // Remembered: the next call doesn't re-probe.
    expect(await memoryChat([{ role: 'user', content: 'again' }])).toBe('{"decision":"new"}');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  });

  it('renames max_tokens on an endpoint that only accepts max_completion_tokens', async () => {
    // Newer OpenAI models reject max_tokens outright, taking the whole call
    // with them — every background job on the memory model goes silent.
    const bad = () =>
      new Response(
        JSON.stringify({
          error:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        }),
        { status: 400 },
      );
    stub(bad(), reply('{"decision":"new"}', 'stop'), reply('{"title":"x"}', 'stop'));

    expect(await memoryChat([{ role: 'user', content: 'hi' }], { maxTokens: 400 })).toBe('{"decision":"new"}');
    expect(bodies[0]!.max_tokens).toBe(400);
    expect(bodies[1]).not.toHaveProperty('max_tokens');
    expect(bodies[1]!.max_completion_tokens).toBe(400);

    // Remembered: the next call doesn't re-probe.
    expect(await memoryChat([{ role: 'user', content: 'again' }], { maxTokens: 1200 })).toBe('{"title":"x"}');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.max_completion_tokens).toBe(1200);
  });

  it('keeps the optional params when a 400 blames something else entirely', async () => {
    // A malformed prompt 400s too; blaming response_format for it would
    // degrade every later call in the container.
    stub(
      new Response(JSON.stringify({ error: 'parse error at line 1, column 2416' }), { status: 400 }),
      reply('{"decision":"continue"}', 'stop'),
    );

    expect(await memoryChat([{ role: 'user', content: 'hi' }], { json: true })).toBeNull();
    expect(bodies).toHaveLength(1);

    expect(await memoryChat([{ role: 'user', content: 'hi' }], { json: true })).toBe('{"decision":"continue"}');
    expect(bodies[1]).toHaveProperty('response_format');
    expect(bodies[1]!.reasoning_effort).toBe('none');
  });

  it('drops a surrogate half left by truncating mid-emoji', async () => {
    stub(reply('{"decision":"continue"}', 'stop'));

    // What `"…🌦️".slice(0, n)` leaves behind.
    await memoryChat([{ role: 'user', content: `last exchange: sunny \ud83c` }]);
    const sent = (bodies[0]!.messages as { content: string }[])[0]!.content;
    expect(sent).toBe('last exchange: sunny ');
  });

  it('returns null without retrying when the model simply had nothing to say', async () => {
    stub(reply('', 'stop'));

    expect(await memoryChat([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(bodies).toHaveLength(1);
  });

  describe('images', () => {
    let imageFile: string;

    beforeEach(() => {
      imageFile = path.join(os.tmpdir(), `memory-model-${process.pid}.png`);
      fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });

    afterEach(() => {
      fs.rmSync(imageFile, { force: true });
    });

    it('appends image parts to the last user message', async () => {
      stub(reply('a water bill', 'stop'));

      await memoryChat(
        [
          { role: 'system', content: 'Describe the attachment.' },
          { role: 'user', content: 'What is this?' },
        ],
        { images: [{ path: imageFile, mimeType: 'image/png' }] },
      );

      const messages = bodies[0]!.messages as { role: string; content: unknown }[];
      // The system message stays a plain string; only the user turn is multimodal.
      expect(typeof messages[0]!.content).toBe('string');
      const parts = messages[1]!.content as { type: string; image_url?: { url: string } }[];
      expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
      expect(parts[1]!.image_url!.url).toStartWith('data:image/png;base64,');
    });

    it('retries text-only when the model has no vision head', async () => {
      // A model without vision rejects the image parts, not the request shape.
      stub(
        new Response(JSON.stringify({ error: 'this model does not support image input' }), { status: 400 }),
        reply('cannot see it', 'stop'),
      );

      expect(
        await memoryChat([{ role: 'user', content: 'What is this?' }], {
          images: [{ path: imageFile, mimeType: 'image/png' }],
        }),
      ).toBe('cannot see it');

      expect(bodies).toHaveLength(2);
      expect(Array.isArray((bodies[1]!.messages as { content: unknown }[])[0]!.content)).toBe(false);
    });

    it('sanitizes text parts, not just plain string bodies', async () => {
      stub(reply('ok', 'stop'));

      await memoryChat([{ role: 'user', content: `receipt for sunny \ud83c` }], {
        images: [{ path: imageFile, mimeType: 'image/png' }],
      });

      const parts = (bodies[0]!.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
      expect(parts[0]!.text).toBe('receipt for sunny ');
    });
  });

  describe('over Responses', () => {
    // The host's ChatGPT proxy: streaming Responses only, no Chat Completions, no temperature.
    function sse(status: 'completed' | 'incomplete', text: string): Response {
      const response = {
        id: 'r1',
        status,
        ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output: text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : [],
      };
      return new Response(`data: ${JSON.stringify({ type: `response.${status}`, response })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    beforeEach(() => {
      process.env.OPENAI_API = 'responses';
    });

    afterEach(() => {
      delete process.env.OPENAI_API;
    });

    it('resolves the main fallback as Responses-only', () => {
      expect(resolveMemoryModel(undefined, { ...process.env })?.api).toBe('responses');
    });

    it('streams a Responses call shaped for the ChatGPT backend', async () => {
      const urls: string[] = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        urls.push(String(url));
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return sse('completed', ' {"topic":"dentist"} ');
      }) as typeof fetch;

      const answer = await memoryChat(
        [
          { role: 'system', content: 'Classify.' },
          { role: 'user', content: 'Move the dentist to Friday' },
        ],
        { json: true, maxTokens: 120, temperature: 0.4 },
      );

      expect(answer).toBe('{"topic":"dentist"}');
      expect(urls).toEqual(['http://memory-model.test/v1/responses']);
      expect(bodies[0]).toEqual({
        model: 'tiny',
        input: [
          { role: 'system', content: 'Classify.' },
          { role: 'user', content: 'Move the dentist to Friday' },
        ],
        max_output_tokens: 120,
        text: { format: { type: 'json_object' } },
        reasoning: { effort: 'none' },
        store: false,
        stream: true,
      });
    });

    it('reads an answer streamed as an item when the completed response leaves its output empty', async () => {
      // The ChatGPT backend delivers each item only in `response.output_item.done`.
      const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
      const events = [
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [] } },
      ];
      stub(
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );

      expect(await memoryChat([{ role: 'user', content: 'sum' }])).toBe('ok');
      expect(bodies).toHaveLength(1);
    });

    it('widens the allowance once when the answer was cut off', async () => {
      stub(sse('incomplete', ''), sse('completed', 'ok'));

      expect(await memoryChat([{ role: 'user', content: 'sum' }], { maxTokens: 50 })).toBe('ok');
      expect(bodies.map((b) => b.max_output_tokens)).toEqual([50, 200]);
    });

    it('drops reasoning effort on a model that refuses it', async () => {
      stub(
        new Response(JSON.stringify({ error: { message: "Unsupported value: 'none' for reasoning.effort" } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
        sse('completed', 'ok'),
      );

      expect(await memoryChat([{ role: 'user', content: 'sum' }])).toBe('ok');
      expect(bodies[0]!.reasoning).toEqual({ effort: 'none' });
      expect(bodies[1]).not.toHaveProperty('reasoning');
    });
  });

  describe('per-endpoint quirks', () => {
    it('does not let a quirk learned on one endpoint poison the other', async () => {
      // `chat` and `summary` can now resolve to different endpoints, so the
      // quirk flags had to stop being container-global: a small local server
      // that rejects `reasoning_effort` must not disable it for a hosted model.
      const seen: { url: string; effort: unknown }[] = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        seen.push({ url: String(url), effort: body.reasoning_effort });
        if (String(url).includes('cheap.') && body.reasoning_effort === 'none') {
          return new Response(JSON.stringify({ error: "unknown parameter 'reasoning_effort'" }), { status: 400 });
        }
        return reply('ok', 'stop');
      }) as typeof fetch;

      process.env.OPENAI_BASE_URL = 'http://cheap.memory-model.test/v1';
      expect(await memoryChat([{ role: 'user', content: 'sum' }])).toBe('ok');

      process.env.OPENAI_BASE_URL = 'http://hosted.memory-model.test/v1';
      expect(await memoryChat([{ role: 'user', content: 'classify' }])).toBe('ok');

      // cheap: probed with 'none', 400'd, retried without. hosted: never degraded.
      expect(seen.filter((s) => s.url.includes('cheap.')).map((s) => s.effort)).toEqual(['none', undefined]);
      expect(seen.filter((s) => s.url.includes('hosted.')).map((s) => s.effort)).toEqual(['none']);
    });
  });
});

describe('parseJsonObject', () => {
  it('parses a bare object', () => {
    expect(parseJsonObject('{"decision":"continue"}')).toEqual({ decision: 'continue' });
  });

  it('parses through code fences and stray prose', () => {
    expect(parseJsonObject('Sure!\n```json\n{"decision":"new","title":"Trip"}\n```')).toEqual({
      decision: 'new',
      title: 'Trip',
    });
  });

  it('repairs the near-JSON small models emit', () => {
    expect(
      parseJsonObject<{ summary: string; openThreads: string[] }>(
        '{"summary":"we settled on Harbourtown","openThreads":["book the ferry"][]}',
      ),
    ).toEqual({ summary: 'we settled on Harbourtown', openThreads: ['book the ferry'] });

    expect(parseJsonObject<{ title: string }>('{"title":"Pasta recipes",}')).toEqual({ title: 'Pasta recipes' });
  });

  it('returns null for malformed or empty output', () => {
    expect(parseJsonObject(null)).toBeNull();
    expect(parseJsonObject('')).toBeNull();
    expect(parseJsonObject('continue')).toBeNull();
    expect(parseJsonObject('{"decision": ')).toBeNull();
  });
});
