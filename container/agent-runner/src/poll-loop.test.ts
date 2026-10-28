import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import type { InMemorySessionClient } from './session/client.js';
import { getPendingMessages, markCompleted, markProcessing } from './db/messages-in.js';
import {
  clearTaskContinuation,
  getContinuation,
  getTaskContinuation,
  setContinuation,
  setTaskContinuation,
} from './db/session-state.js';
import { writeMessageOut } from './db/messages-out.js';
import { getAllDestinations, makeRoutingResolver } from './destinations.js';
import { formatMessages, extractRouting, setOriginResolver, type RoutingContext } from './formatter.js';
import { dispatchResultText, episodeDrainDelayMs, resolveStatusTarget, selectExecutionBatch } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import { EMPTY_ANSWER_FALLBACK } from './reply-contract.js';
import { setCurrentTaskRun } from './current-batch.js';

let client: InMemorySessionClient;

beforeEach(() => {
  client = installTestSessionClient();
  setOriginResolver(() => undefined);
});

afterEach(() => {
  setCurrentTaskRun(null);
  resetTestSessionClient();
  setOriginResolver(() => undefined);
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  client.seedInbound({
    id,
    kind,
    content: JSON.stringify(content),
    process_after: opts?.processAfter ?? null,
    trigger: opts?.trigger ?? 1,
    on_wake: opts?.onWake ?? 0,
  });
}

function insertWithRouting(
  id: string,
  kind: string,
  content: object,
  channelType: string | null,
  platformId: string | null,
): void {
  client.seedInbound({
    id,
    kind,
    content: JSON.stringify(content),
    channel_type: channelType,
    platform_id: platformId,
  });
}

function seedDestination(name: string, channelType: string, platformId: string): void {
  client.destinations.push({
    name,
    display_name: name,
    type: 'channel',
    channel_type: channelType,
    platform_id: platformId,
    agent_group_id: null,
  });
}

/** Populate the formatter's sync origin resolver from the seeded destinations. */
async function refreshResolver(): Promise<void> {
  setOriginResolver(makeRoutingResolver(await getAllDestinations()));
}

describe('formatter', () => {
  it('should format a single chat message', async () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', async () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', async () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('identifies a recurring occurrence and its scheduled time', async () => {
    client.seedInbound({
      id: 'run-2',
      kind: 'task',
      content: JSON.stringify({ prompt: 'Invented report' }),
      series_id: 'series-1',
      process_after: '2026-01-02T08:00:00.000Z',
      timestamp: '2026-01-01T08:00:00.000Z',
    });
    const row = client.inbound[0]!;
    const prompt = formatMessages([row]);
    expect(prompt).toContain('series_id="series-1"');
    expect(prompt).toContain('run_id="run-2"');
    expect(prompt).toContain('scheduled_for=');
    expect(prompt).toContain('Do not create another copy');
  });

  it('should format webhook messages', async () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', async () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', async () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', async () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = await getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('runs a due task independently of earlier context-only chat and later chat', async () => {
    insertMessage('context', 'chat', { text: 'ambient chatter' }, { trigger: 0 });
    insertMessage('run-a', 'task', { prompt: 'Invented daily report' });
    insertMessage('user', 'chat', { text: 'new question' });
    const batch = selectExecutionBatch(await getPendingMessages());
    expect(batch.map((message) => message.id)).toEqual(['run-a']);
  });

  it('keeps two due tasks in separate batches', async () => {
    insertMessage('run-a', 'task', { prompt: 'First report' });
    insertMessage('run-b', 'task', { prompt: 'Second report' });
    expect(selectExecutionBatch(await getPendingMessages()).map((message) => message.id)).toEqual(['run-a']);
  });

  it('getPendingMessages returns both trigger=0 and trigger=1 rows', async () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = await getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger defaults to 1 for inserts without explicit value', async () => {
    client.seedInbound({ id: 'm1', kind: 'chat', content: '{"text":"hi"}' });
    const [msg] = await getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('scheduled run continuation', () => {
  it('resumes only the matching run and leaves interactive history intact', async () => {
    await setContinuation('mock', 'chat-history');
    await setTaskContinuation('mock', 'run-a', 'task-history-a');
    await setTaskContinuation('mock', 'run-b', 'task-history-b');
    expect(await getContinuation('mock')).toBe('chat-history');
    expect(await getTaskContinuation('mock', 'run-a')).toBe('task-history-a');
    expect(await getTaskContinuation('mock', 'run-b')).toBe('task-history-b');
    await clearTaskContinuation('mock', 'run-a');
    expect(await getTaskContinuation('mock', 'run-a')).toBeUndefined();
    expect(await getContinuation('mock')).toBe('chat-history');
    expect(await getTaskContinuation('mock', 'run-b')).toBe('task-history-b');
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', async () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = await getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', async () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = await getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', async () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(await getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    await markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(await getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', async () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = await getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', async () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = await getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', async () => {
    client.seedInbound({ id: 'm1', kind: 'chat', content: '{"text":"hi"}' });
    // Should be returned even on non-first poll (on_wake=0)
    expect(await getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', async () => {
    insertWithRouting('m1', 'chat', { text: 'hi' }, 'telegram', 'chan-123');
    client.inbound[0].thread_id = 'thread-456';

    const messages = await getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('telegram');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  it('chat message includes from= when destination matches', async () => {
    seedDestination('telegram-main', 'telegram', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chan-1');
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('from="telegram-main"');
  });

  it('chat message falls back to raw routing when no destination matches', async () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', async () => {
    seedDestination('cli-ops', 'cli', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'cli', 'C-OPS');
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="cli-ops"');
  });

  it('task message omits from= when routing is null', async () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', async () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', async () => {
    seedDestination('telegram-main', 'telegram', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'telegram', 'chan-1');
    await refreshResolver();
    const prompt = formatMessages(await getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="telegram-main"');
  });
});

describe('streaming fixture provider contract', () => {
  it('emits a continuation and processes input queued before end', async () => {
    const query = new MockProvider({}, (value) => `Fixture response: ${value}`).query({ prompt: 'one', cwd: '/tmp' });
    query.push('two');
    query.end();
    const events = [];
    for await (const event of query.events) events.push(event);
    expect(events.find((event) => event.type !== 'activity')?.type).toBe('init');
    expect(events.filter((event) => event.type === 'result').map((event) => event.text)).toEqual([
      'Fixture response: one',
      'Fixture response: two',
    ]);
  });
  it('accepts a follow-up after the first response has streamed', async () => {
    const query = new MockProvider({}, (value) => value.toUpperCase()).query({ prompt: 'alpha', cwd: '/tmp' });
    const received: string[] = [];
    for await (const event of query.events) {
      if (event.type !== 'result') continue;
      received.push(event.text!);
      if (received.length === 1) query.push('beta');
      else query.end();
    }
    expect(received).toEqual(['ALPHA', 'BETA']);
  });
});

describe('end-to-end with mock provider', () => {
  it('should read inbound, process with mock provider, write outbound', async () => {
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    const messages = await getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    await markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        await writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    await markCompleted(['m1']);

    // Verify: message was processed (no longer pending).
    const processed = await getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to the outbound side of session.db.
    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe('The answer is 4');
    expect(client.outbound[0].in_reply_to).toBe('m1');
  });
});

describe('progress status routing', () => {
  it('keeps the scheduled task as the anchor when replying to its own channel', async () => {
    seedDestination('ada', 'telegram', 'telegram:123');
    // A later human message exists in the same destination. Looking up the
    // destination's latest inbound would return this id and inflate the task
    // timer; status must stay anchored to the batch being processed.
    insertWithRouting('latest-human-message', 'chat', { text: 'unrelated' }, 'telegram', 'telegram:123');

    const routing = {
      channelType: 'telegram',
      platformId: 'telegram:123',
      threadId: null,
      inReplyTo: 'scheduled-task-1',
      senderIsPrivileged: true,
      hotMemorySlug: null,
      episodesEnabled: false,
    } satisfies RoutingContext;

    await expect(resolveStatusTarget(routing)).resolves.toEqual({
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      thread_id: null,
      in_reply_to: 'scheduled-task-1',
    });
  });
});

/**
 * `dispatchResultText` is the last gate before the user. Both of its failure
 * modes were silent: a blank `<message>` envelope delivered an empty chat
 * bubble, and a reply that was entirely `<internal>` scratchpad delivered
 * nothing at all without so much as a log line.
 */
describe('dispatchResultText — never a blank bubble, never silence', () => {
  const routing = {
    channelType: 'telegram',
    platformId: 'telegram:123',
    threadId: null,
    inReplyTo: 'm1',
    senderIsPrivileged: false,
  } as unknown as RoutingContext;

  beforeEach(() => {
    seedDestination('bo', 'telegram', 'telegram:123');
  });

  it('never sends a blank <message> envelope as an empty bubble', async () => {
    await dispatchResultText('<message to="bo">   </message>', routing);

    // The envelope is dropped rather than delivered blank, and since that left
    // the turn with no answer at all, the fallback takes its place.
    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe(EMPTY_ANSWER_FALLBACK);
  });

  it('still delivers the non-blank envelopes alongside a blank one', async () => {
    await dispatchResultText('<message to="bo"></message><message to="bo">the real answer</message>', routing);

    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe('the real answer');
  });

  it('falls back rather than going silent when the whole reply was internal', async () => {
    const { sent } = await dispatchResultText('<internal>thinking out loud</internal>', routing);

    expect(sent).toBe(1);
    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe(EMPTY_ANSWER_FALLBACK);
  });

  it('leaves a genuinely empty result alone — nothing to answer, nothing to apologize for', async () => {
    const { sent } = await dispatchResultText('   ', routing);

    expect(sent).toBe(0);
    expect(client.outbound).toHaveLength(0);
  });

  it('delivers a plain answer to the reply destination', async () => {
    await dispatchResultText('Take the third one.', routing);

    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe('Take the third one.');
  });

  it('links a scheduled report to its run even without a conversation reply anchor', async () => {
    setCurrentTaskRun({
      seriesId: 'digest-series',
      runId: 'digest-run-17',
      scheduledFor: '2031-04-03T07:00:00Z',
      prompt: 'Invented daily report',
      recurrence: null,
    });
    await dispatchResultText('A source-backed daily report.', { ...routing, inReplyTo: null });
    expect(client.outbound[0]?.in_reply_to).toBe('digest-run-17');
  });
});

/**
 * A background writer holds the memory service's single embedding/reranker slot for as long as it
 * runs — 12–24s in production. Racing it into the gap after a reply is what made the next turn's
 * pre-turn recall time out whenever someone was talking quickly. It waits for a gap now, and this
 * is the policy that decides when.
 */
describe('episode-summary drain quiet gate', () => {
  const now = 1_000_000;

  it('defers the first schedule after a turn', () => {
    expect(episodeDrainDelayMs({ now, deferredSince: null, isDeferred: false })).toBe(8_000);
  });

  it('keeps deferring while the conversation stays inside the cap', () => {
    expect(episodeDrainDelayMs({ now, deferredSince: now - 30_000, isDeferred: false })).toBe(8_000);
  });

  it('runs anyway once a busy conversation has held it past the cap', () => {
    expect(episodeDrainDelayMs({ now, deferredSince: now - 90_001, isDeferred: false })).toBeNull();
  });

  it('runs immediately when the quiet timer already fired', () => {
    expect(episodeDrainDelayMs({ now, deferredSince: now, isDeferred: true })).toBeNull();
  });

  // The flag has to stay its own thing rather than a falsy sentinel on a counter: folded together,
  // the timer re-arms itself on every fire and the drain never runs at all.
  it('treats a fired timer as distinct from a fresh schedule at the same instant', () => {
    expect(episodeDrainDelayMs({ now, deferredSince: now, isDeferred: true })).toBeNull();
    expect(episodeDrainDelayMs({ now, deferredSince: now, isDeferred: false })).toBe(8_000);
  });
});
