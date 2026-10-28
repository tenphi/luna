import { describe, expect, it, vi } from 'vitest';

import { createQuietDeliver } from './telegram.js';
import type { TelegramDraftSender } from './telegram-draft.js';

function fakeDrafts(opts?: { available?: boolean }) {
  const sends: Array<{ draftId: number; text: string }> = [];
  const drafts: TelegramDraftSender = {
    async send(_platformId, _threadId, draftId, text) {
      sends.push({ draftId, text });
      return opts?.available !== false;
    },
    async clear() {},
  };
  return { drafts, sends };
}

describe('createQuietDeliver — reply streaming', () => {
  it('renders a stream update as a live draft, not a message', async () => {
    const { drafts, sends } = fakeDrafts();
    const fallback = vi.fn();
    const deliver = createQuietDeliver(drafts, fallback);

    const id = await deliver('telegram:42', null, {
      kind: 'chat',
      content: { operation: 'stream', streamId: 3, text: 'The answer so far' },
    });

    expect(sends).toEqual([{ draftId: 3, text: 'The answer so far' }]);
    // A draft is not a message: no id to record, and nothing sent through the bridge.
    expect(id).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('throws when the chat cannot take drafts, so the caller stops streaming', async () => {
    const { drafts } = fakeDrafts({ available: false });
    const deliver = createQuietDeliver(drafts, vi.fn());

    await expect(
      deliver('telegram:-1001234567890', null, {
        kind: 'chat',
        content: { operation: 'stream', streamId: 1, text: 'preview' },
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('rejects a stream update with no usable stream id', async () => {
    const { drafts, sends } = fakeDrafts();
    const deliver = createQuietDeliver(drafts, vi.fn());

    await expect(
      deliver('telegram:42', null, { kind: 'chat', content: { operation: 'stream', text: 'preview' } }),
    ).rejects.toThrow();
    expect(sends).toHaveLength(0);
  });
});

describe('createQuietDeliver — messages', () => {
  it('routes silent content through the no-sound path', async () => {
    const { drafts, sends } = fakeDrafts();
    const fallback = vi.fn().mockResolvedValue('7');
    const deliver = createQuietDeliver(drafts, fallback);

    const id = await deliver('telegram:42', null, {
      kind: 'chat',
      content: { text: '🤔 Thinking…', plain: true, silent: true },
    });

    expect(id).toBe('7');
    expect(sends).toHaveLength(0);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary reply on the ordinary path', async () => {
    const { drafts, sends } = fakeDrafts();
    const fallback = vi.fn().mockResolvedValue('9');
    const deliver = createQuietDeliver(drafts, fallback);

    const id = await deliver('telegram:42', null, { kind: 'chat', content: { markdown: 'Here you go' } });

    expect(id).toBe('9');
    expect(sends).toHaveLength(0);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
