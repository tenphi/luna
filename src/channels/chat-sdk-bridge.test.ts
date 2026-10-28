import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, Attachment, Message, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit, toInboundMessage } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

function makePostCapture() {
  const calls: { threadId: string; message: AdapterPostableMessage }[] = [];
  const postMessage = vi.fn(async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'synthetic-post', threadId, raw: {} };
  });
  return { postMessage, calls };
}

it.each([
  ['Ada’s short note', 50],
  ['Paragraph one.\n\nParagraph two.\n\nParagraph three.', 24],
  ['First line\nSecond line\nThird line', 15],
  ['x'.repeat(121), 23],
  ['🐈'.repeat(15), 7],
])('splits a fixture into bounded chunks without losing words or splitting Unicode', (text, limit) => {
  const chunks = splitForLimit(String(text), Number(limit));
  expect(chunks.join('').replace(/\s/g, '')).toBe(String(text).replace(/\s/g, ''));
  expect(chunks.every((chunk) => chunk.length <= Number(limit))).toBe(true);
  expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
});
it('exposes only the DM functionality supplied by its transport', async () => {
  expect(createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: false }).openDM).toBeUndefined();
  const openDM = vi.fn(async (user: string) => `thread:${user}`);
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({ openDM, channelIdFromThreadId: (thread) => thread.replace('thread:', 'fixture:') }),
    supportsThreads: false,
  });
  expect(await bridge.openDM!('ada')).toBe('fixture:ada');
  expect(openDM).toHaveBeenCalledWith('ada');
});
describe('toInboundMessage — replies to a file', () => {
  const reply = (raw: Record<string, unknown>) =>
    ({
      id: 'fixture-reply',
      raw,
      attachments: [],
      metadata: { dateSent: new Date('2026-10-28T14:20:25.000Z') },
      toJSON: () => ({
        id: 'fixture-reply',
        text: 'save in memory',
        attachments: [],
        author: { fullName: 'Ada Marlow' },
      }),
    }) as unknown as Message;
  const document: Attachment = {
    type: 'file',
    name: 'fixture-contract.pdf',
    mimeType: 'application/pdf',
    fetchData: async () => Buffer.from('%PDF-fixture'),
  };

  it('brings the quoted file along, marked as quoted', async () => {
    const inbound = await toInboundMessage(
      {
        adapter: stubAdapter({}),
        supportsThreads: false,
        extractReplyContext: () => ({ sender: 'Ada', text: '', id: '42:8' }),
        extractQuotedAttachments: () => [document],
      },
      reply({ reply_to_message: {} }),
      true,
      false,
    );
    const content = inbound.content as Record<string, unknown>;
    expect(content.replyTo).toEqual({ sender: 'Ada', text: '', id: '42:8' });
    expect(content.attachments).toEqual([
      expect.objectContaining({
        type: 'file',
        name: 'fixture-contract.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-fixture').toString('base64'),
        quoted: true,
      }),
    ]);
  });

  it('still routes the reply when the quoted files cannot be read', async () => {
    const inbound = await toInboundMessage(
      {
        adapter: stubAdapter({}),
        supportsThreads: false,
        extractQuotedAttachments: () => {
          throw new Error('synthetic parse failure');
        },
      },
      reply({ reply_to_message: {} }),
      true,
      false,
    );
    expect((inbound.content as Record<string, unknown>).attachments).toEqual([]);
    expect((inbound.content as Record<string, unknown>).text).toBe('save in memory');
  });
});

it('offers thread subscription for the router’s sticky mentions', () => {
  expect(createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true }).subscribe).toBeTypeOf('function');
});

describe('createChatSdkBridge.deliver — plain status text', () => {
  it('posts plain/raw when content.plain is set (progress bubbles)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: '✅ Done in 5s\n📅 List calendars\n📅 List events', plain: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toEqual({
      raw: '✅ Done in 5s\n📅 List calendars\n📅 List events',
    });
  });

  it('edits with raw when content.plain is set', async () => {
    const edits: Array<{ messageId: string; message: AdapterPostableMessage }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (_tid, messageId, message) => {
          edits.push({ messageId, message });
          return { id: messageId, threadId: 't', raw: {} };
        },
      }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: '42:1',
        text: '✅ Done in 5s\n📅 Delete event',
        plain: true,
      },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0].message).toEqual({ raw: '✅ Done in 5s\n📅 Delete event' });
  });

  it('never runs the outbound markdown transform on plain text', async () => {
    const { calls, postMessage } = makePostCapture();
    const edits: AdapterPostableMessage[] = [];
    const transformed: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage,
        editMessage: async (_tid, messageId, message) => {
          edits.push(message);
          return { id: messageId, threadId: 't', raw: {} };
        },
      }),
      supportsThreads: false,
      transformOutboundText: (text) => {
        transformed.push(text);
        return `transformed: ${text}`;
      },
    });

    const divider = '💬 Review a synthetic bag - https://example.com/products/field-bag';
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: divider, plain: true },
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: '42:1', text: divider, plain: true },
    });

    expect(calls[0].message).toEqual({ raw: divider });
    expect(edits[0]).toEqual({ raw: divider });
    expect(transformed).toEqual([]);
  });
});

describe('createChatSdkBridge.deliver — plain chat-sdk payloads', () => {
  it('posts text as markdown', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('createChatSdkBridge.deliver — maxTextLength splits', () => {
  it('posts multiple messages when text exceeds maxTextLength', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 40,
    });
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { markdown: text },
    });
    expect(id).toBe('synthetic-post');
    expect(calls.length).toBeGreaterThan(1);
    const chunks = calls.map((c) => (c.message as { markdown: string }).markdown);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks.join('\n\n')).toContain('para one');
    expect(chunks.join('\n\n')).toContain('para two');
  });
});

describe('createChatSdkBridge.deliver — resuming a partial split send', () => {
  const LONG_TEXT = 'alpha alpha alpha\n\nbravo bravo bravo\n\ncharlie charlie\n\ndelta delta delta';

  /** Post handler that rejects the nth (0-based) call, then behaves. */
  function failingAt(failIndex: number) {
    const sent: string[] = [];
    let call = 0;
    const postMessage = async (_threadId: string, message: AdapterPostableMessage) => {
      const body = (message as { markdown?: string; raw?: string }).markdown ?? '';
      if (call++ === failIndex) {
        const err = new Error('Rate limited by telegram');
        err.name = 'AdapterRateLimitError';
        throw err;
      }
      sent.push(body);
      return { id: `msg-${sent.length}`, threadId: _threadId, raw: {} } as RawMessage<unknown>;
    };
    return { sent, postMessage };
  }

  it('resends only the chunks the platform never accepted', async () => {
    const { sent, postMessage } = failingAt(2);
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 20,
    });
    const message = { id: 'out-long-1', kind: 'chat-sdk', content: { markdown: LONG_TEXT } };

    await expect(bridge.deliver('telegram:42', null, message)).rejects.toThrow('Rate limited');
    const beforeRetry = [...sent];
    expect(beforeRetry.length).toBe(2);

    // The delivery layer retries the whole message; the user must not read the
    // first two chunks twice.
    await bridge.deliver('telegram:42', null, message);

    expect(sent.slice(0, 2)).toEqual(beforeRetry);
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('keeps the original head id so edits still target the first post', async () => {
    const { postMessage } = failingAt(1);
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 20,
    });
    const message = { id: 'out-long-2', kind: 'chat-sdk', content: { markdown: LONG_TEXT } };

    await expect(bridge.deliver('telegram:42', null, message)).rejects.toThrow('Rate limited');

    await expect(bridge.deliver('telegram:42', null, message)).resolves.toBe('msg-1');
  });

  it('starts over for a message with no id — nothing to resume against', async () => {
    const { sent, postMessage } = failingAt(2);
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 20,
    });
    const message = { kind: 'chat-sdk', content: { markdown: LONG_TEXT } };

    await expect(bridge.deliver('telegram:42', null, message)).rejects.toThrow('Rate limited');
    await bridge.deliver('telegram:42', null, message);

    // Duplicates are the honest outcome here: without a stable id the bridge
    // cannot know these two calls are the same reply.
    expect(new Set(sent).size).toBeLessThan(sent.length);
  });

  it('forgets a completed send so the next reply is not treated as a resume', async () => {
    const { sent, postMessage } = failingAt(-1);
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
      maxTextLength: 20,
    });
    const message = { id: 'out-long-3', kind: 'chat-sdk', content: { markdown: LONG_TEXT } };

    await bridge.deliver('telegram:42', null, message);
    const firstPass = sent.length;
    expect(firstPass).toBeGreaterThan(1);

    await bridge.deliver('telegram:42', null, message);

    expect(sent.length).toBe(firstPass * 2);
  });
});
