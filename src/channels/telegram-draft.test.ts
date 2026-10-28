import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTelegramDraftSender } from './telegram-draft.js';

type Call = { method: string; body: Record<string, unknown> };

function stubTelegram(calls: Call[], opts?: { fail?: boolean }): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: url.slice(url.lastIndexOf('/') + 1),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const payload = opts?.fail
      ? { ok: false, error_code: 400, description: 'Bad Request: CHAT_TYPE_INVALID' }
      : { ok: true, result: true };
    return new Response(JSON.stringify(payload), {
      status: opts?.fail ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('createTelegramDraftSender', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts a draft with the given id and no parse mode', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    expect(await drafts.send('telegram:42', null, 5, 'The answer so far')).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendMessageDraft');
    expect(calls[0].body.chat_id).toBe('42');
    expect(calls[0].body.draft_id).toBe(5);
    expect(calls[0].body.text).toBe('The answer so far');
    // Mid-stream markdown can't be parsed and would re-animate when completed.
    expect(calls[0].body).not.toHaveProperty('parse_mode');
  });

  it('replaces the same draft when the id is reused', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    await drafts.send('telegram:42', null, 5, 'The answer');
    await drafts.send('telegram:42', null, 5, 'The answer so far');

    expect(calls.map((c) => c.body.draft_id)).toEqual([5, 5]);
    expect(calls[1].body.text).toBe('The answer so far');
  });

  it('clears a draft with empty text', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    await drafts.clear('telegram:42', null, 7);

    expect(calls[0].body.draft_id).toBe(7);
    expect(calls[0].body.text).toBe('');
  });

  it('declines group chats without calling the API — drafts are user-only', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    // Telegram group/supergroup/channel ids are negative.
    expect(await drafts.send('telegram:-1001234567890', null, 1, 'text')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports false when the API rejects the draft', async () => {
    stubTelegram(calls, { fail: true });
    const drafts = createTelegramDraftSender('test-token');

    expect(await drafts.send('telegram:42', null, 1, 'text')).toBe(false);
  });

  it('swallows a failed clear — the draft expires on its own', async () => {
    stubTelegram(calls, { fail: true });
    const drafts = createTelegramDraftSender('test-token');

    await expect(drafts.clear('telegram:42', null, 3)).resolves.toBeUndefined();
  });

  it('passes a forum topic id through as message_thread_id', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    await drafts.send('telegram:42', '99', 1, 'text');

    expect(calls[0].body.message_thread_id).toBe(99);
  });

  it('omits message_thread_id when the thread is just the platform id', async () => {
    stubTelegram(calls);
    const drafts = createTelegramDraftSender('test-token');

    await drafts.send('telegram:42', 'telegram:42', 1, 'text');

    expect(calls[0].body).not.toHaveProperty('message_thread_id');
  });
});
