import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import type { InMemorySessionClient, DestRow, OutRowForTests } from './session/client.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

let client: InMemorySessionClient;

/** Outbound rows the container wrote this run (delivery is host-side now). */
function undelivered(): OutRowForTests[] {
  return client.outbound;
}

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  const row: DestRow = {
    name,
    display_name: displayName,
    type: 'channel',
    channel_type: channelType,
    platform_id: platformId,
    agent_group_id: null,
  };
  client.destinations.push(row);
}

beforeEach(() => {
  client = installTestSessionClient();
  // Seed a destination so output parsing can resolve "telegram-test" → routing
  seedDestination('telegram-test', 'Telegram Test', 'telegram', 'chan-1');
});

afterEach(() => {
  resetTestSessionClient();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  client.seedInbound({
    id,
    kind: 'chat',
    content: JSON.stringify(content),
    platform_id: opts?.platformId ?? null,
    channel_type: opts?.channelType ?? null,
    thread_id: opts?.threadId ?? null,
  });
}

describe('poll loop integration', () => {
  it('keeps silent context pending until a triggered turn can consume it', async () => {
    client.seedInbound({
      id: 'silent-fixture',
      kind: 'chat',
      content: '{"text":"Earlier synthetic context"}',
      trigger: 0,
    });
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return 'Fixture answer';
    });
    const controller = new AbortController();
    const loop = runPollLoopWithTimeout(provider, controller.signal, 4000);
    try {
      await sleep(80);
      expect(prompts).toEqual([]);
      expect(client.inbound.find((row) => row.id === 'silent-fixture')?.status).toBe('pending');
      client.seedInbound({ id: 'trigger-fixture', kind: 'chat', content: '{"text":"Answer now"}', trigger: 1 });
      await waitFor(() => prompts.length === 1, 2000);
      expect(prompts[0]).toContain('Earlier synthetic context');
      expect(prompts[0]).toContain('Answer now');
    } finally {
      controller.abort();
      await loop.catch(() => {});
    }
  });

  it('injects external memory edits into a real turn and later steering without changing routing', async () => {
    client.memoryEdits = [
      { id: 'edit-first', file: 'notes/preferences.md', diff: '- morning\n+ afternoon', truncated: false },
    ];
    insertMessage('m1', { sender: 'Ada', text: 'Plan a meeting.' }, { platformId: 'chan-1', channelType: 'telegram' });
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="telegram-test">Acknowledged.</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);
    await waitFor(() => prompts.length === 1 && client.memoryEdits.length === 0, 2000);
    expect(prompts[0]).toContain('<external_memory_edits');
    expect(prompts[0]).toContain('notes/preferences.md');
    expect(client.outbound[0].in_reply_to).toBe('m1');
    client.memoryEdits = [
      { id: 'edit-second', file: 'notes/preferences.md', diff: '- afternoon\n+ evening', truncated: false },
    ];
    insertMessage(
      'm2',
      { sender: 'Ada', text: 'Use that correction.' },
      { platformId: 'chan-1', channelType: 'telegram' },
    );
    await waitFor(() => prompts.length === 2 && client.memoryEdits.length === 0, 2000);
    expect(prompts[1]).toContain('+ evening');
    expect(prompts[1]).not.toContain('+ afternoon');
    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="telegram-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('42');
    expect(out[out.length - 1].platform_id).toBe('chan-1');
    expect(out[out.length - 1].channel_type).toBe('telegram');
    expect(out[out.length - 1].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = await getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('keeps status events off the durable queue and lands the terminal one before the answer', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'hi' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'thread-1' },
    );

    // Status events and outbound rows live in separate stores now, so record a
    // shared ordering to assert the turn's 'done' beats the answer it belongs
    // to — otherwise the host could collapse the bubble after the reply lands.
    const order: string[] = [];
    const realStatus = client.writeStatus.bind(client);
    const realOut = client.writeMessageOut.bind(client);
    client.writeStatus = async (ev) => {
      order.push(`status:${ev.payload.phase}`);
      return realStatus(ev);
    };
    client.writeMessageOut = async (msg) => {
      order.push(`out:${msg.kind}`);
      return realOut(msg);
    };

    const provider = new MockProvider({}, () => '<message to="telegram-test">42</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    expect(client.outbound.some((r) => r.kind === 'status')).toBe(false);
    expect(client.statusEvents.length).toBeGreaterThan(0);
    expect(client.statusEvents[0].inReplyTo).toBe('m1');

    const doneAt = order.indexOf('status:done');
    const chatAt = order.indexOf('out:chat');
    expect(doneAt).toBeGreaterThanOrEqual(0);
    expect(chatAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeLessThan(chatAt);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="telegram-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    seedDestination('cli-test', 'CLI Test', 'cli', 'chan-2');

    // Insert messages from each destination with distinct thread IDs
    insertMessage(
      'm-telegram',
      { sender: 'Alice', text: 'from telegram' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'telegram-thread-1' },
    );
    insertMessage(
      'm-cli',
      { sender: 'Bob', text: 'from cli' },
      { platformId: 'chan-2', channelType: 'cli', threadId: 'cli-thread-99' },
    );

    // Agent replies to both destinations
    const provider = new MockProvider(
      {},
      () => '<message to="telegram-test">reply-d</message><message to="cli-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length >= 2, 2000);
    controller.abort();

    const out = undelivered();
    const telegramOut = out.find((m) => m.platform_id === 'chan-1');
    const cliOut = out.find((m) => m.platform_id === 'chan-2');

    expect(telegramOut).toBeDefined();
    expect(telegramOut!.thread_id).toBe('telegram-thread-1');
    expect(telegramOut!.in_reply_to).toBe('m-telegram');

    expect(cliOut).toBeDefined();
    expect(cliOut!.thread_id).toBe('cli-thread-99');
    expect(cliOut!.in_reply_to).toBe('m-cli');

    await loopPromise.catch(() => {});
  });

  it('short bare text delivers to the reply destination', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new MockProvider({}, () => 'Hi!');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('Hi!');

    await loopPromise.catch(() => {});
  });

  it('bare text auto-delivers to the reply destination', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'telegram' });

    const reply = 'Here is the answer.';
    const provider = new MockProvider({}, () => reply);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe(reply);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="telegram-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    // Only the valid destination should produce output
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('delivered');
    expect(out[out.length - 1].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    seedDestination('cli-test', 'CLI Test', 'cli', 'chan-2');

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new MockProvider(
      {},
      () => '<message to="telegram-test">for telegram</message><message to="cli-test">for cli</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length >= 2, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(2);
    const telegramOutMsg = out.find((m) => m.platform_id === 'chan-1' && JSON.parse(m.content).text === 'for telegram');
    const cliOutMsg = out.find((m) => m.platform_id === 'chan-2' && JSON.parse(m.content).text === 'for cli');
    expect(telegramOutMsg).toBeDefined();
    expect(cliOutMsg).toBeDefined();

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    seedDestination('cli-new', 'CLI New', 'cli', 'chan-new');

    // Only insert a message from telegram — cli-new has never sent anything
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'tell cli' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'telegram-thread' },
    );

    const provider = new MockProvider({}, () => '<message to="cli-new">hello cli</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1].platform_id).toBe('chan-new');
    expect(out[out.length - 1].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage(
      'm-old',
      { sender: 'Alice', text: 'old' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'thread-old' },
    );
    insertMessage(
      'm-new',
      { sender: 'Alice', text: 'new' },
      { platformId: 'chan-1', channelType: 'telegram', threadId: 'thread-new' },
    );

    const provider = new MockProvider({}, () => '<message to="telegram-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1].thread_id).toBe('thread-new');
    expect(out[out.length - 1].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="telegram-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    // Insert message after loop has started (allow first poll iteration to begin)
    await sleep(500);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => undelivered().length > 0, 4000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new MockProvider(
      {},
      () =>
        '<internal>thinking about this...</internal><message to="telegram-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'telegram' });
    // Task with same routing — simulates a scheduled task in a channel session
    client.seedInbound({
      id: 't-task',
      kind: 'task',
      content: JSON.stringify({ prompt: 'daily check' }),
      platform_id: 'chan-1',
      channel_type: 'telegram',
    });

    const provider = new MockProvider({}, () => '<message to="telegram-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    // The signal goes into the loop as well as the race: without it the loop
    // outlives the test and starts answering the next test's messages.
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const expires = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= expires) throw new Error('Synthetic integration condition did not become ready');
    await sleep(Math.min(50, expires - Date.now()));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — provider error recovery', () => {
  it('writes simplified error to outbound for unprivileged senders', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    const text = JSON.parse(out[out.length - 1].content).text as string;
    expect(text).toContain('Something went wrong');
    expect(text).not.toContain('API rate limit exceeded');

    await loopPromise.catch(() => {});
  });

  it('writes detailed error to outbound for privileged senders', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'trigger error', _luna: { senderIsPrivileged: true } },
      { platformId: 'chan-1', channelType: 'telegram' },
    );

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = await getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    await setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'telegram' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toContain('Something went wrong');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(await getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /compact command', () => {
  it('compacts session, writes confirmation, skips query', async () => {
    await setContinuation('mock', 'existing-session-id');

    client.seedInbound({
      id: 'm-compact',
      kind: 'chat',
      content: JSON.stringify({ text: '/compact' }),
      platform_id: 'chan-1',
      channel_type: 'telegram',
    });

    const provider = new MockProvider({}, () => '<message to="telegram-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toMatch(
      /No active session to compact|Context compacted|does not support this command/,
    );

    const pending = await getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    await setContinuation('mock', 'existing-session-id');
    expect(await getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    client.seedInbound({
      id: 'm-clear',
      kind: 'chat',
      content: JSON.stringify({ text: '/clear' }),
      platform_id: 'chan-1',
      channel_type: 'telegram',
    });

    const provider = new MockProvider({}, () => '<message to="telegram-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => undelivered().length > 0, 2000);
    controller.abort();

    const out = undelivered();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[out.length - 1].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(await getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = await getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}

/**
 * Session API resilience.
 *
 * Kept last in the file: earlier tests leave their poll loop running (there is
 * no way to stop runPollLoop other than letting the process end), so anything
 * that asserts on *which* outbound row appeared has to tolerate a stray writer
 * from a previous test.
 */
describe('poll loop — Session API resilience', () => {
  it('survives a failed first poll and still delivers the wake message', async () => {
    // on_wake rows are surfaced only on the first poll, so a first poll that
    // throws must not consume that one chance. The loop used to propagate the
    // failure out of runPollLoop and end the container process outright,
    // stranding every claimed message in `processing`.
    client.seedInbound({
      id: 'm-wake',
      kind: 'chat',
      content: JSON.stringify({ sender: 'system', text: 'restarted' }),
      platform_id: 'chan-1',
      channel_type: 'telegram',
      on_wake: 1,
    });

    let polls = 0;
    const realPending = client.getPendingMessages.bind(client);
    client.getPendingMessages = (isFirstPoll: boolean) => {
      polls++;
      if (polls <= 2) return Promise.reject(new Error('session-api getPendingMessages → HTTP 502'));
      return realPending(isFirstPoll);
    };

    const provider = new MockProvider({}, () => '<message to="telegram-test">back online</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    const sent = () => undelivered().some((r) => (JSON.parse(r.content) as { text?: string }).text === 'back online');
    await waitFor(sent, 5000);
    controller.abort();

    expect(polls).toBeGreaterThan(2);
    expect(sent()).toBe(true);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — duplicate-answer guard', () => {
  it('does not hand a follow-up to the model when closing its claim fails', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'telegram' });

    // The claim close for the follow-up fails. If the push happened first, the
    // model would answer a message still marked `processing`, the host sweep
    // would replay it on the next container kill, and the user would get the
    // same answer twice.

    const realCompleted = client.markCompleted.bind(client);
    client.markCompleted = (ids: string[]) => {
      if (ids.includes('m2')) return Promise.reject(new Error('session-api markCompleted → HTTP 502'));
      return realCompleted(ids);
    };

    const pushed: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      pushed.push(prompt);
      return '<message to="telegram-test">answered</message>';
    });

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 4000);

    // Let the first turn settle, then land the follow-up mid-query.
    await waitFor(() => pushed.length >= 1, 4000);
    insertMessage('m2', { sender: 'Alice', text: 'second' }, { platformId: 'chan-1', channelType: 'telegram' });
    await sleep(1200);
    controller.abort();

    // m2 never reached the model, so nothing answered it and the replay the
    // host sweep will eventually do is the first and only answer.
    expect(pushed.some((p) => p.includes('second'))).toBe(false);
    expect(client.outbound.some((r) => r.in_reply_to === 'm2')).toBe(false);

    await loopPromise.catch(() => {});
  });
});
