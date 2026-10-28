import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createProgressSession,
  discardStaleProgressSession,
  handleStatusEvent,
  finalizeProgressSession,
  getProgressAnchor,
  hasProgressSession,
  destroyProgressSession,
  interruptProgressSession,
} from './controller.js';
import type { ProgressSink } from './controller.js';
import { noteAgentMemoryWriteFromTool } from '../memory/digest.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSink(): ProgressSink & {
  sends: string[];
  edits: Array<{ id: string; text: string }>;
  deletes: string[];
} {
  const sink = {
    isCli: false,
    sends: [] as string[],
    edits: [] as Array<{ id: string; text: string }>,
    deletes: [] as string[],
    async sendStatus(text: string): Promise<string | undefined> {
      sink.sends.push(text);
      return `msg-${sink.sends.length}`;
    },
    async editStatus(id: string, text: string): Promise<void> {
      sink.edits.push({ id, text });
    },
    async deleteStatus(id: string): Promise<void> {
      sink.deletes.push(id);
    },
  };
  return sink;
}

function makeCliSink(): ProgressSink & { frames: string[][] } {
  const sink = {
    isCli: true,
    frames: [] as string[][],
    async sendStatus(_text: string): Promise<string | undefined> {
      return undefined;
    },
    async editStatus(_id: string, _text: string): Promise<void> {},
    pushCliStatus(lines: string[]) {
      sink.frames.push([...lines]);
    },
  };
  return sink;
}

const SESSION = 'test-session-abc';

beforeEach(() => {
  vi.useFakeTimers();
  destroyProgressSession(SESSION); // clean slate
});

afterEach(() => {
  destroyProgressSession(SESSION);
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Reveal thresholds
// ---------------------------------------------------------------------------

describe('reveal thresholds', () => {
  it('suppresses the process message when turn finishes in < 5s (no tools)', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    // Done immediately at ~2s
    vi.advanceTimersByTime(2000);
    await handleStatusEvent(SESSION, { phase: 'done' });

    expect(sink.sends).toHaveLength(0);
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('suppresses when no tools and turn finishes before 5s', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(4000);
    await handleStatusEvent(SESSION, { phase: 'done' });

    expect(sink.sends).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('deletes a revealed thinking-only bubble when the turn finishes (no Done summary)', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink, {
      channelType: 'telegram',
      platformId: 'telegram:1',
      threadId: null,
    });

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(7000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(sink.sends.length).toBeGreaterThan(0); // bubble revealed

    await handleStatusEvent(SESSION, { phase: 'done' });
    // Thinking-only turns never collapse to "✅ Done in Ns"; the transient
    // bubble is deleted and the answer is delivered as its own message.
    expect(sink.edits.some((e) => e.text.includes('✅ Done in'))).toBe(false);
    expect(sink.deletes).toEqual([`msg-${sink.sends.length}`]);
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('reveals immediately when a tool is seen', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'foo' } });
    expect(sink.sends).toHaveLength(1);
  });

  it('reveals on pure-thinking turn after 5s', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(6000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(sink.sends.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edit throttle
// ---------------------------------------------------------------------------

describe('edit throttle', () => {
  it('does not edit immediately after a send (< 1s throttle window)', async () => {
    const t0 = Date.now() - 6000; // already past reveal threshold (tool + 5s scenario)
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    // The tool event triggers an immediate maybeSend since we're already revealed.
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'q' } });
    expect(sink.sends).toHaveLength(1);

    // Advance only 900ms — the ticker won't fire (TICK_MS=1000).
    // The edit throttle window (1s) has not elapsed, so no edit occurs.
    vi.advanceTimersByTime(900);
    await Promise.resolve();

    expect(sink.edits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Finalize — collapsed done summary
// ---------------------------------------------------------------------------

describe('finalizeProgressSession', () => {
  it('edits to done summary when process message was sent', async () => {
    const t0 = Date.now() - 8000; // 8s ago, will reveal with tools
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'bar' } });
    // Advance enough to trigger one ticker tick → initial send
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(sink.sends).toHaveLength(1);

    await finalizeProgressSession(SESSION);
    // The last edit must be the collapsed done summary
    const lastEdit = sink.edits[sink.edits.length - 1];
    expect(lastEdit).toBeDefined();
    expect(lastEdit!.text).toContain('✅ Done in');
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('is a no-op when called twice', async () => {
    const t0 = Date.now() - 6000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: {} });
    vi.advanceTimersByTime(5000);
    await Promise.resolve();

    await finalizeProgressSession(SESSION);
    const editCount = sink.edits.length;
    await finalizeProgressSession(SESSION); // second call — no-op
    expect(sink.edits.length).toBe(editCount);
  });
});

// ---------------------------------------------------------------------------
// Interrupted turns
// ---------------------------------------------------------------------------

describe('interruptProgressSession', () => {
  it('does not claim the turn is done', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'bar' } });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(sink.sends).toHaveLength(1);

    await interruptProgressSession(SESSION);

    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit.text).toContain('⚠️ Interrupted after');
    expect(lastEdit.text).not.toContain('✅ Done in');
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('names the retry so the wait is not silent', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: {} });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    await interruptProgressSession(SESSION, 'retrying in 20s');

    expect(sink.edits[sink.edits.length - 1]!.text).toContain('retrying in 20s');
  });

  it('keeps the tool timeline so the user sees how far it got', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'bar' } });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    await interruptProgressSession(SESSION);

    expect(sink.edits[sink.edits.length - 1]!.text.split('\n').length).toBeGreaterThan(1);
  });

  it('stays quiet when no bubble was ever shown', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await interruptProgressSession(SESSION);

    // Nothing on screen to correct — a surprise bubble here would be the sweep
    // announcing itself to a user who never saw anything go wrong.
    expect(sink.sends).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('is a no-op after the turn already finished', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: {} });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await finalizeProgressSession(SESSION);

    const editCount = sink.edits.length;
    await interruptProgressSession(SESSION);
    expect(sink.edits.length).toBe(editCount);
  });

  it('reports the interruption on the CLI too', async () => {
    const t0 = Date.now() - 6000;
    const sink = makeCliSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'q' } });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    await interruptProgressSession(SESSION, 'retrying in 5s');

    const last = sink.frames[sink.frames.length - 1]!.join(' ');
    expect(last).toContain('Interrupted after');
    expect(last).toContain('retrying in 5s');
  });
});

// ---------------------------------------------------------------------------
// CLI sink
// ---------------------------------------------------------------------------

describe('CLI progress sink', () => {
  it('pushes lines frames to CLI sink and emits done one-liner', async () => {
    const t0 = Date.now() - 6000; // already past reveal threshold
    const sink = makeCliSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'q' } });
    // One tick to trigger initial push
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(sink.frames.length).toBeGreaterThan(0);

    await finalizeProgressSession(SESSION);
    const last = sink.frames[sink.frames.length - 1]!;
    expect(last.join(' ')).toContain('Done in');
  });
});

// ---------------------------------------------------------------------------
// Luna internal tools are skipped
// ---------------------------------------------------------------------------

describe('partial tools and plain lines', () => {
  it('updates tool line from partial compose to full summary', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__memory__recall',
      index: 0,
      partial: true,
    });
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__memory__recall',
      args: { query: 'flights' },
      index: 0,
      partial: false,
    });

    expect(sink.sends[0]).toContain('Recalling');
    expect(sink.sends[0]).not.toContain('flights');

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const lastText = sink.edits[sink.edits.length - 1]?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    expect(lastText).toContain('flights');
  });

  it('ignores bare generating events and strips Typing when a tool starts', async () => {
    const t0 = Date.now() - 11000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, { phase: 'generating' });
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__tavily__search',
      index: 0,
      partial: true,
    });

    const visible = [...sink.sends, ...sink.edits.map((e) => e.text)].join('\n');
    expect(visible).not.toContain('Typing');
    expect(visible).toContain('Searching');
  });

  it('never shows agent prose (generating) in the process message', async () => {
    const t0 = Date.now() - 11000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    await handleStatusEvent(SESSION, { phase: 'generating', text: 'Let me check.' });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const visible = [...sink.sends, ...sink.edits.map((e) => e.text)].join('\n');
    // Prose is delivered as its own chat message by the container, never folded
    // into the process/status bubble.
    expect(visible).not.toContain('Let me check.');
    expect(visible).toContain('Thinking');
  });

  it('shows nothing for a quick turn that finishes before the reveal threshold', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(2000);
    await handleStatusEvent(SESSION, { phase: 'done' });

    expect(sink.sends).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
  });
});

describe('thinking is ephemeral and tools are subtle', () => {
  it('replaces the thinking line with the tool call once a tool runs', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__memory__recall',
      args: { query: 'x' },
      index: 0,
    });

    const last = sink.edits[sink.edits.length - 1]?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    expect(last).toContain('Recalling');
    expect(last).not.toContain('Thinking');
  });

  it('renders a completed tool without a green checkmark', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'Bash', args: { command: 'ls' }, index: 0 });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'Read', args: { file_path: '/x' }, index: 1 });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const last = sink.edits[sink.edits.length - 1]?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    // The first (now completed) tool line must not carry a checkmark.
    expect(last).toContain('⚙️');
    expect(last).not.toContain('✓');
  });
});

describe('discardStaleProgressSession', () => {
  it('deletes an orphaned thinking-only bubble on new-turn close', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink, {
      channelType: 'telegram',
      platformId: 'telegram:1',
      threadId: null,
    });

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    vi.advanceTimersByTime(7000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sink.sends.length).toBeGreaterThan(0); // bubble was revealed

    await discardStaleProgressSession(SESSION);

    // The revealed bubble's message id is deleted (last id sent by the sink).
    expect(sink.deletes).toEqual([`msg-${sink.sends.length}`]);
    expect(hasProgressSession(SESSION)).toBe(false);
    // No stale "Thinking…" edit and no "Done in Ns" collapse for a thinking turn.
    expect(sink.edits.some((e) => e.text.includes('✅ Done in'))).toBe(false);
  });

  it('does not delete (and is a no-op) when no bubble was ever shown', async () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    // Only ~2s elapsed — never revealed, so no messageId.
    vi.advanceTimersByTime(2000);

    await discardStaleProgressSession(SESSION);

    expect(sink.deletes).toHaveLength(0);
    expect(sink.sends).toHaveLength(0);
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('collapses a tool turn to its Done summary instead of deleting', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'q' } });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(sink.sends).toHaveLength(1);

    await discardStaleProgressSession(SESSION);

    expect(sink.deletes).toHaveLength(0);
    const lastEdit = sink.edits[sink.edits.length - 1];
    expect(lastEdit!.text).toContain('✅ Done in');
    expect(hasProgressSession(SESSION)).toBe(false);
  });
});

describe('turn anchor', () => {
  it('exposes the per-turn anchor for new-turn detection', () => {
    const t0 = Date.now();
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink, {
      channelType: 'telegram',
      platformId: 'telegram:1',
      threadId: null,
      anchor: 'in-42',
    });
    expect(getProgressAnchor(SESSION)).toBe('in-42');
  });
});

describe('tool index scoping across model streams', () => {
  it('keeps separate tool lines when stream index 0 is reused after thinking', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__memory__query',
      args: { query: 'foo' },
      index: 0,
      partial: false,
    });
    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__tavily__search',
      args: { query: 'bar' },
      index: 0,
      partial: false,
    });

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const visible = [...sink.sends, ...sink.edits.map((e) => e.text)].join('\n');
    // Two separate tool lines from reused stream index 0: the memory query
    // (🧠) and the tavily search (🌐), each with its own summary.
    expect(visible).toContain('🧠');
    expect(visible).toContain('🌐');
    expect(visible).toContain('foo');
    expect(visible).toContain('bar');
  });
});

describe('Typing line while generating after tools', () => {
  it('shows Typing… on generating after tools instead of collapsing early', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'food' } });
    expect(sink.sends).toHaveLength(1);

    await handleStatusEvent(SESSION, { phase: 'generating', text: 'Here is your answer...' });
    await handleStatusEvent(SESSION, { phase: 'generating', text: 'Here is your answer... longer' });

    expect(hasProgressSession(SESSION)).toBe(true);
    const live = sink.edits[sink.edits.length - 1]?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    expect(live).toContain('Typing');
    expect(live).not.toContain('✅ Done in');
    expect(live).not.toContain('Here is your answer');

    await handleStatusEvent(SESSION, { phase: 'done' });
    const doneText = sink.edits[sink.edits.length - 1]!.text;
    expect(doneText).toContain('✅ Done in');
    expect(doneText).not.toContain('Typing');
    expect(hasProgressSession(SESSION)).toBe(false);
  });

  it('does not show Typing before more tools when generating is only a preamble', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__memory__recall',
      args: { query: 'first' },
      index: 0,
      partial: false,
    });
    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, { phase: 'generating', text: 'Let me check.' });
    // After tools, generating switches to Typing — then a new tool replaces it.
    await handleStatusEvent(SESSION, {
      phase: 'tool',
      name: 'mcp__tavily__search',
      index: 0,
      partial: true,
    });

    const visible = [...sink.sends, ...sink.edits.map((e) => e.text)].join('\n');
    expect(visible).not.toContain('✅ Done in');
    expect(visible).toContain('Searching');
    expect(hasProgressSession(SESSION)).toBe(true);
  });
});

describe('multi-tool turn', () => {
  it('finalizes once with all tools when phase done arrives after several tool steps', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'Bash', args: { command: 'ls' }, index: 0 });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'Read', args: { file_path: '/x' }, index: 1 });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'food' }, index: 2 });

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    const sendsBefore = sink.sends.length;
    const editsBefore = sink.edits.length;

    await handleStatusEvent(SESSION, { phase: 'done' });

    expect(sink.sends.length).toBe(sendsBefore);
    expect(sink.edits.length).toBe(editsBefore + 1);

    const doneText = sink.edits[sink.edits.length - 1]!.text;
    expect(doneText).toContain('✅ Done in');
    expect(doneText).toContain('Ran'); // Bash → "Ran"
    expect(doneText).toContain('Read');
    expect(doneText).toContain('Recalled'); // memory recall, past tense in the done summary
    expect(hasProgressSession(SESSION)).toBe(false);
  });
});

describe('duplicate finalize guard', () => {
  it('ignores phase done after session was already finalized', async () => {
    const t0 = Date.now() - 8000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__memory__recall', args: { query: 'q' } });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    await finalizeProgressSession(SESSION);
    const sendsAfter = sink.sends.length;
    const editsAfter = sink.edits.length;

    await handleStatusEvent(SESSION, { phase: 'done' });
    expect(sink.sends.length).toBe(sendsAfter);
    expect(sink.edits.length).toBe(editsAfter);
  });

  it('does not send bare done when finalizing empty session without messageId', async () => {
    const t0 = Date.now() - 12000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await finalizeProgressSession(SESSION);
    expect(sink.sends).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
  });
});

describe('internal tool filtering', () => {
  it('does not add a status line for mcp__luna__ tools', async () => {
    const t0 = Date.now() - 11000; // far past all reveal thresholds
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'mcp__luna__send_message', args: {} });

    // Advance one tick to trigger initial send
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    // Only the thinking line should exist; luna tool is skipped
    await finalizeProgressSession(SESSION);
    const lastEdit = sink.edits[sink.edits.length - 1];
    const doneText = lastEdit?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    // send_message should not appear in the done summary
    expect(doneText).not.toContain('Send message');
  });

  it('does not add a status line for domain-prefixed luna tools', async () => {
    const t0 = Date.now() - 11000;
    const sink = makeSink();
    createProgressSession(SESSION, t0, sink);

    await handleStatusEvent(SESSION, { phase: 'thinking' });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'send_message', args: {} });
    await handleStatusEvent(SESSION, { phase: 'tool', name: 'list_tasks', args: {} });

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    await finalizeProgressSession(SESSION);
    const lastEdit = sink.edits[sink.edits.length - 1];
    const doneText = lastEdit?.text ?? sink.sends[sink.sends.length - 1] ?? '';
    expect(doneText).not.toContain('Send message');
    expect(doneText).not.toContain('List tasks');
  });

  it('notes a memory write even when no progress session is active', async () => {
    // The after-the-turn digest reads this to decide whether to stand down, and a turn with no
    // progress UI is still a turn.
    await handleStatusEvent('no-session', {
      phase: 'tool',
      name: 'mcp__memory__write',
      args: { slug: 'household/lease' },
    });
    // Recorded against the session, which is the granularity the digest asks about.
    expect(() => noteAgentMemoryWriteFromTool('no-session', 'mcp__memory__write')).not.toThrow();
  });
});

it('shows accepted reasoning effort in the completed tool bubble and resets it for another turn', async () => {
  const sink = makeSink();
  const start = Date.now();
  createProgressSession('effort-fixture', start, sink);
  await handleStatusEvent('effort-fixture', { phase: 'effort', effort: 'high' });
  await handleStatusEvent('effort-fixture', {
    phase: 'tool',
    name: 'Read',
    args: { file_path: '/workspace/agent/example.txt' },
  });
  await handleStatusEvent('effort-fixture', { phase: 'effort', effort: 'untrusted\ntext' });
  await finalizeProgressSession('effort-fixture');
  expect(sink.edits.at(-1)?.text).toContain('· reasoning: high');
  expect(sink.edits.at(-1)?.text).not.toContain('untrusted');
  createProgressSession('effort-fixture', start, sink);
  await handleStatusEvent('effort-fixture', {
    phase: 'tool',
    name: 'Read',
    args: { file_path: '/workspace/agent/example.txt' },
  });
  await finalizeProgressSession('effort-fixture');
  expect(sink.edits.at(-1)?.text).not.toContain('reasoning:');
});

it('keeps effort carried by the terminal status when live metadata was coalesced', async () => {
  const sink = makeSink();
  createProgressSession('effort-terminal-fixture', Date.now(), sink);
  await handleStatusEvent('effort-terminal-fixture', {
    phase: 'tool',
    name: 'Read',
    args: { file_path: '/workspace/agent/example.txt' },
  });
  await handleStatusEvent('effort-terminal-fixture', { phase: 'done', effort: 'medium' });
  expect(sink.edits.at(-1)?.text).toContain('· reasoning: medium');
});
