import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractReplyContext, extractTelegramReplyText, quotedTelegramAttachments } from './telegram.js';

describe('Telegram rich messages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends GFM tables through sendRichMessage', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 7,
            date: 1_786_543_200,
            chat: { id: 42, type: 'private' },
            text: 'Visible reply',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const adapter = createTelegramAdapter({ botToken: 'test-token' });
    const markdown = '| Check | Detail |\n|---|---|\n| Service | running |';

    await adapter.postMessage('telegram:42', { markdown });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith('/sendRichMessage')).toBe(true);
    expect(calls[0].body).toMatchObject({ rich_message: { markdown } });
  });

  it('falls back to sendMessage and remembers when rich messages are unsupported', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (url.endsWith('/sendRichMessage')) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: rich message is unsupported',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: calls.length,
            date: 1_786_543_200,
            chat: { id: 42, type: 'private' },
            text: 'Visible fallback',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const adapter = createTelegramAdapter({ botToken: 'test-token' });
    const markdown = '| Check | Detail |\n|---|---|\n| Service | running |';

    await adapter.postMessage('telegram:42', { markdown });
    await adapter.postMessage('telegram:42', { markdown: '**Next** reply' });

    expect(calls.map((call) => new URL(call.url).pathname.split('/').at(-1))).toEqual([
      'sendRichMessage',
      'sendMessage',
      'sendMessage',
    ]);
    expect(calls[1].body.text).toEqual(expect.stringContaining('Check'));
  });
});

describe('extractTelegramReplyText', () => {
  it('prefers plain text', () => {
    expect(extractTelegramReplyText({ text: 'hello', caption: 'cap' })).toBe('hello');
  });

  it('falls back to caption', () => {
    expect(extractTelegramReplyText({ caption: 'photo caption' })).toBe('photo caption');
  });

  it('reads rich_message.markdown (Luna outbound path)', () => {
    expect(
      extractTelegramReplyText({
        rich_message: { markdown: '**Bold** agent reply' },
      }),
    ).toBe('**Bold** agent reply');
  });

  it('walks rich_message.blocks when markdown is absent', () => {
    expect(
      extractTelegramReplyText({
        rich_message: {
          blocks: [{ type: 'paragraph', text: 'From blocks' }],
        },
      }),
    ).toBe('From blocks');
  });

  it('returns empty string when nothing usable', () => {
    expect(extractTelegramReplyText({})).toBe('');
  });
});

describe('extractReplyContext', () => {
  it('returns null when not a reply', () => {
    expect(extractReplyContext({ text: 'hi', chat: { id: 1 } })).toBeNull();
  });

  it('extracts plain reply with composite id', () => {
    expect(
      extractReplyContext({
        chat: { id: 1000000001 },
        text: 'follow up',
        reply_to_message: {
          message_id: 42,
          text: 'original',
          from: { first_name: 'Bob', username: 'bob' },
        },
      }),
    ).toEqual({
      text: 'original',
      sender: 'Bob',
      id: '1000000001:42',
    });
  });

  it('extracts rich_message quote with empty text/caption', () => {
    expect(
      extractReplyContext({
        chat: { id: 1000000001 },
        text: 'Then what does this mean?',
        reply_to_message: {
          message_id: 6634,
          text: undefined,
          caption: undefined,
          rich_message: { markdown: 'The letter is a renewal notice…' },
          from: { first_name: 'Luna', username: 'luna_bot' },
        },
      }),
    ).toEqual({
      text: 'The letter is a renewal notice…',
      sender: 'Luna',
      id: '1000000001:6634',
    });
  });

  it('uses username when first_name is missing', () => {
    expect(
      extractReplyContext({
        chat: { id: 1 },
        reply_to_message: {
          message_id: 2,
          text: 'hi',
          from: { username: 'alice' },
        },
      }),
    ).toMatchObject({ sender: 'alice', id: '1:2' });
  });
});

describe('quotedTelegramAttachments', () => {
  const adapter = createTelegramAdapter({ botToken: 'test-token' });

  it('returns the file of the message a reply quotes', () => {
    // The reported shape: "save in memory" sent as a reply to a forwarded, uncaptioned document.
    const files = quotedTelegramAttachments(adapter, {
      chat: { id: 42, type: 'private' },
      message_id: 9,
      text: 'save in memory',
      reply_to_message: {
        chat: { id: 42, type: 'private' },
        message_id: 8,
        date: 1_786_543_200,
        from: { id: 7, is_bot: false, first_name: 'Ada' },
        forward_origin: { type: 'user', date: 1_786_500_000, sender_user: { id: 8, is_bot: false, first_name: 'Bo' } },
        document: {
          file_id: 'fixture-file',
          file_name: 'fixture-contract.pdf',
          mime_type: 'application/pdf',
          file_size: 1024,
        },
      },
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      type: 'file',
      name: 'fixture-contract.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    });
    expect(files[0]!.fetchData).toBeTypeOf('function');
  });

  it('returns nothing for a plain message or a quote without files', () => {
    expect(quotedTelegramAttachments(adapter, { chat: { id: 42 }, message_id: 9, text: 'hello' })).toEqual([]);
    expect(
      quotedTelegramAttachments(adapter, {
        chat: { id: 42 },
        message_id: 9,
        text: 'yes',
        reply_to_message: { chat: { id: 42, type: 'private' }, message_id: 8, date: 1_786_543_200, text: 'Coming?' },
      }),
    ).toEqual([]);
  });
});
