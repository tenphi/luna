import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endReplyStream, noteReplyText } from './reply-stream.js';
import { setProgressSinkFactory } from './status-events.js';

const DEST = { channelType: 'telegram', platformId: 'telegram:42', threadId: null };

type Update = { streamId: number; text: string };

/** Install a sink that records streamReply calls. `fail` makes the channel refuse. */
function installSink(opts?: { fail?: boolean; omit?: boolean }): Update[] {
  const updates: Update[] = [];
  setProgressSinkFactory(() => ({
    isCli: false,
    async sendStatus() {
      return undefined;
    },
    async editStatus() {},
    ...(opts?.omit
      ? {}
      : {
          async streamReply(streamId: number, text: string) {
            if (opts?.fail) throw new Error('unavailable');
            updates.push({ streamId, text });
          },
        }),
  }));
  return updates;
}

/** Let the pending timer fire and its async flush settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('reply-stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    endReplyStream('s1');
    vi.useRealTimers();
  });

  it('shows the first text immediately', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'Hello');
    await tick(0);

    expect(updates).toEqual([{ streamId: expect.any(Number), text: 'Hello' }]);
  });

  it('coalesces a burst into one update per second, keeping the latest text', async () => {
    const updates = installSink();

    // The provider emits every ~300ms; Telegram allows far fewer calls.
    noteReplyText('s1', DEST, 'a');
    await tick(0);
    noteReplyText('s1', DEST, 'ab');
    noteReplyText('s1', DEST, 'abc');
    noteReplyText('s1', DEST, 'abcd');
    await tick(300);

    // Still inside the interval — nothing beyond the first send.
    expect(updates).toHaveLength(1);

    await tick(700);
    // One catch-up update carrying the newest text, not each intermediate one.
    expect(updates).toHaveLength(2);
    expect(updates[1].text).toBe('abcd');
  });

  it('keeps one draft id while the text keeps growing', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'The');
    await tick(0);
    noteReplyText('s1', DEST, 'The answer');
    await tick(1000);

    expect(updates).toHaveLength(2);
    expect(updates[1].streamId).toBe(updates[0].streamId);
  });

  it('starts a new draft when prose restarts after a tool call', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'Checking the calendar for you');
    await tick(0);
    // That segment was delivered as its own message; the next model stream
    // accumulates from empty, so the text no longer extends what we saw.
    noteReplyText('s1', DEST, 'You have two meetings');
    await tick(1000);

    expect(updates).toHaveLength(2);
    expect(updates[1].streamId).not.toBe(updates[0].streamId);
    expect(updates[1].text).toBe('You have two meetings');
  });

  it('skips an update that would resend identical text', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'Same');
    await tick(0);
    noteReplyText('s1', DEST, 'Same');
    await tick(2000);

    expect(updates).toHaveLength(1);
  });

  it('sends the text verbatim, markdown markers and all', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, '**Bold** and `code`');
    await tick(0);

    // Stripping markdown would remove characters already shown, restarting the
    // client's fade-in. The real message that replaces the draft is formatted.
    expect(updates[0].text).toBe('**Bold** and `code`');
  });

  it('every preview extends the previous one as an answer is revealed', async () => {
    // The property that keeps the chat from jumping: the client animates added
    // characters, so a preview must never contradict what it already showed.
    const answer = [
      "Here's what I found. The **status bubble** uses `disable_notification`, and:",
      '',
      '1. Drafts are user-only',
      '2. They expire on their own',
      '',
      'See [the docs](https://core.telegram.org/api/bots/ai) for details.',
    ].join('\n');

    const updates = installSink();
    for (let i = 1; i <= answer.length; i++) {
      noteReplyText('s1', DEST, answer.slice(0, i));
      // Every emission gets through, so the check covers each intermediate step.
      await tick(1000);
    }

    expect(updates.length).toBeGreaterThan(1);
    const breaks = updates.filter((u, i) => i > 0 && !u.text.startsWith(updates[i - 1].text));
    expect(breaks).toEqual([]);
    expect(updates.at(-1)?.text).toBe(answer.trimEnd());
  });

  it('truncates a preview past the Telegram limit', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'x'.repeat(5000));
    await tick(0);

    expect(updates[0].text).toHaveLength(4096);
  });

  it('stops streaming for the turn once the channel refuses', async () => {
    installSink({ fail: true });
    const seen: string[] = [];
    // Re-install a recording sink after the failure to prove nothing else is sent.
    noteReplyText('s1', DEST, 'first');
    await tick(0);

    setProgressSinkFactory(() => ({
      isCli: false,
      async sendStatus() {
        return undefined;
      },
      async editStatus() {},
      async streamReply(_id: number, text: string) {
        seen.push(text);
      },
    }));
    noteReplyText('s1', DEST, 'first and more');
    await tick(2000);

    expect(seen).toEqual([]);
  });

  it('does nothing on a channel with no streaming support', async () => {
    const updates = installSink({ omit: true });

    noteReplyText('s1', DEST, 'Hello');
    await tick(1000);

    expect(updates).toEqual([]);
  });

  it('leaves the draft alone at end of turn so the real message replaces it', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'Done thinking');
    await tick(0);
    endReplyStream('s1');
    await tick(5000);

    // No clear, no further update — the delivered answer clears the draft.
    expect(updates).toHaveLength(1);
  });

  it('starts a fresh draft on the next turn after the stream ended', async () => {
    const updates = installSink();

    noteReplyText('s1', DEST, 'Turn one');
    await tick(0);
    endReplyStream('s1');
    noteReplyText('s1', DEST, 'Turn two');
    await tick(0);

    expect(updates[1].streamId).not.toBe(updates[0].streamId);
  });
});
