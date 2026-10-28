import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enableTelegramSilentSends, isSilentContent, withSilentTelegramSends } from './telegram-silent.js';

type Call = { method: string; body: Record<string, unknown> };

/** Record every Bot API call and answer each with a plausible ok result. */
function stubTelegram(calls: Call[], delayMs = 0): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: url.slice(url.lastIndexOf('/') + 1),
      body: init?.body instanceof FormData ? {} : (JSON.parse(String(init?.body)) as Record<string, unknown>),
    });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: calls.length, date: 1_786_543_200, chat: { id: 42, type: 'private' }, text: 'ok' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

describe('enableTelegramSilentSends', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  function adapter(): ReturnType<typeof createTelegramAdapter> {
    const a = createTelegramAdapter({ botToken: 'test-token' });
    enableTelegramSilentSends(a);
    return a;
  }

  it('sends with disable_notification inside withSilentTelegramSends', async () => {
    stubTelegram(calls);
    const a = adapter();

    await withSilentTelegramSends(() => a.postMessage('telegram:42', { raw: 'Thinking…' }));

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].body.disable_notification).toBe(true);
  });

  it('leaves ordinary sends notifying', async () => {
    stubTelegram(calls);
    const a = adapter();

    await a.postMessage('telegram:42', { raw: 'Here is your answer' });

    expect(calls[0].body).not.toHaveProperty('disable_notification');
  });

  it('does not touch methods with no notification to suppress', async () => {
    stubTelegram(calls);
    const a = adapter();

    await withSilentTelegramSends(() => a.startTyping('telegram:42'));

    expect(calls[0].method).toBe('sendChatAction');
    expect(calls[0].body).not.toHaveProperty('disable_notification');
  });

  it('does not leak the flag onto a concurrent ordinary send', async () => {
    // The bridge delivers concurrently: a module-level flag set around an
    // await would silence whatever else was in flight.
    stubTelegram(calls, 10);
    const a = adapter();

    await Promise.all([
      withSilentTelegramSends(() => a.postMessage('telegram:42', { raw: 'status' })),
      a.postMessage('telegram:43', { raw: 'answer' }),
    ]);

    const silent = calls.find((c) => c.body.text === 'status');
    const loud = calls.find((c) => c.body.text === 'answer');
    expect(silent?.body.disable_notification).toBe(true);
    expect(loud?.body).not.toHaveProperty('disable_notification');
  });
});

describe('isSilentContent', () => {
  it('reads the outbound content flag', () => {
    expect(isSilentContent({ text: 'hi', plain: true, silent: true })).toBe(true);
    expect(isSilentContent({ text: 'hi', plain: true })).toBe(false);
    expect(isSilentContent({ silent: 'yes' })).toBe(false);
    expect(isSilentContent(null)).toBe(false);
  });
});
