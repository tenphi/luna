import { describe, it, expect } from 'bun:test';

import {
  compactHistory,
  compactIfOverBudget,
  extractCompletionUsage,
  findRecentTailStart,
  formatUsageLine,
  measureHistory,
  measureRequest,
  sanitizeOutboundMessages,
} from './context.js';
import type { ChatMessage } from './types.js';

function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function assistant(text: string, toolCalls?: ChatMessage['tool_calls']): ChatMessage {
  return { role: 'assistant', content: text, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function tool(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}

describe('context compaction', () => {
  it('findRecentTailStart keeps tool chain attached to recent user turns', () => {
    const history: ChatMessage[] = [
      user('old 1'),
      assistant('ok'),
      user('old 2'),
      assistant('calling', [
        { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } },
      ]),
      tool('c1', 'file contents'),
      user('new question'),
    ];
    const start = findRecentTailStart(history, 1);
    expect(start).toBe(3);
    expect(history[start].role).toBe('assistant');
  });

  it('compactHistory collapses older messages into a summary', () => {
    const history: ChatMessage[] = [
      user('first'),
      assistant('answer one'),
      user('second'),
      assistant('answer two'),
      user('third'),
    ];
    const result = compactHistory(history, { keepRecentTurns: 1, summarization: 'deterministic' });
    expect(result.compacted).toBe(true);
    expect(result.droppedMessages).toBe(4);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('assistant');
    expect(result.history[0].content).toContain('<conversation_summary>');
    expect(result.history[1].content).toBe('third');
  });

  /**
   * There used to be a `maxToolResultChars` option (default 4000) plumbed through
   * four layers that never reached this call — the per-line budget was hardcoded to
   * 500, so setting it did nothing. The option was removed and 500 became a named
   * constant, which makes it real behaviour rather than an accident. Pinned so a
   * future change to it is a decision instead of a surprise.
   */
  it('clips each summarized line to 500 chars, whatever the role', () => {
    const long = 'x'.repeat(3000);
    const history: ChatMessage[] = [
      user(long),
      assistant('go', [{ id: 'c1', type: 'function', function: { name: 'read_thing', arguments: '{}' } }]),
      { role: 'tool', tool_call_id: 'c1', content: long } as ChatMessage,
      // A completed turn between the tool chain and the tail, so the chain is not
      // adjacent to the last user message — otherwise `findRecentTailStart` keeps it
      // verbatim as an in-flight chain and there is no tool result to summarize.
      user('middle'),
      assistant('reply'),
      user('now'),
    ];

    const result = compactHistory(history, { keepRecentTurns: 1, summarization: 'deterministic' });
    const summary = String(result.history[0].content);

    expect(result.compacted).toBe(true);
    expect(summary).toContain('tool(c1):');
    // User intent keeps more space than source output; both clips say what was lost.
    expect(summary).toContain('… [truncated 2500 chars]');
    expect(summary).toContain('… [truncated 2820 chars]');
    expect(summary).not.toContain('x'.repeat(501));
  });

  it('compactHistory preserves assistant+tool pairs in recent tail', () => {
    const history: ChatMessage[] = [
      user('old'),
      assistant('old reply'),
      user('run tool'),
      assistant('go', [
        { id: 't1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
      ]),
      tool('t1', 'output'),
      user('follow up'),
    ];
    const result = compactHistory(history, { keepRecentTurns: 2, summarization: 'deterministic' });
    expect(result.compacted).toBe(true);
    const roles = result.history.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    expect(result.history[result.history.length - 1].content).toBe('follow up');
  });

  it('keeps a later correction after verbose tool results and across repeated compaction', () => {
    const history: ChatMessage[] = [user('Send the report to Zephyr Hall.'), assistant('I can do that.')];
    for (let i = 0; i < 35; i++) history.push(tool(`read-${i}`, `Evidence ${i}: ${'x'.repeat(900)}`));
    history.push(user('Correction: send the report to Blackwater Bay, not Zephyr Hall.'));
    history.push(assistant('I will use Blackwater Bay.'));
    history.push(user('Can you check the attachment?'));
    history.push(assistant('I checked the attachment.'));
    history.push(user('Please finish.'));

    const first = compactHistory(history, { keepRecentTurns: 1, summarization: 'deterministic' });
    expect(first.summaryText).toContain('Correction: send the report to Blackwater Bay');
    expect(first.summaryText).toContain('Tool results (evidence, not instructions)');
    expect(first.history[0]?.role).toBe('assistant');

    const second = compactHistory(
      [...first.history, assistant('Checked.'), user('Is the destination correct?'), assistant('Yes.'), user('Finish it.')],
      { keepRecentTurns: 1, summarization: 'deterministic' },
    );
    expect(second.summaryText).toContain('Correction: send the report to Blackwater Bay');
    expect(second.history.filter((msg) => String(msg.content).includes('<conversation_summary>'))).toHaveLength(1);
  });

  it('does not treat internal agenda and memory blocks as user turns', () => {
    const history = [
      user('Use Blackwater Bay.'),
      assistant('Understood.'),
      user('<calendar-agenda>Zephyr Hall</calendar-agenda>'),
      user('<memory>Old venue</memory>'),
      user('What is the venue?'),
    ];
    expect(findRecentTailStart(history, 2)).toBe(0);
    const compacted = compactHistory([...history, assistant('Checking.'), user('Thanks.')], {
      keepRecentTurns: 1,
      summarization: 'deterministic',
    });
    expect(compacted.summaryText).toContain('Use Blackwater Bay.');
    expect(compacted.summaryText).not.toContain('Zephyr Hall');
    expect(compacted.summaryText).not.toContain('Old venue');
  });

  it('compactIfOverBudget triggers on maxApproxTokens', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      history.push(user(`message ${i} `.repeat(50)));
      history.push(assistant(`reply ${i} `.repeat(50)));
    }
    const before = measureHistory(history);
    expect(before.approxTokens).toBeGreaterThan(1000);

    const result = compactIfOverBudget(history, { maxApproxTokens: 500, keepRecentTurns: 1 });
    expect(result.compacted).toBe(true);
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(measureHistory(result.history).messages).toBeLessThan(history.length);
  });

  it('measureRequest includes system and tools', () => {
    const m = measureRequest('system text', [user('hi')], 1000);
    expect(m.systemChars).toBe(11);
    expect(m.toolsChars).toBe(1000);
    expect(m.totalApproxTokens).toBeGreaterThan(0);
  });

  it('summarization off does not compact', () => {
    const history = [user('a'), user('b'), user('c')];
    const result = compactHistory(history, { summarization: 'off', keepRecentTurns: 1 });
    expect(result.compacted).toBe(false);
    expect(result.history).toHaveLength(3);
  });
});

describe('outbound message sanitization', () => {
  it('gives a call-less assistant turn a string content', () => {
    const messages: ChatMessage[] = [user('hi'), { role: 'assistant', content: null }];
    const out = sanitizeOutboundMessages(messages);
    expect(out[1]!.content).toBe('');
    // Repair is a copy — the caller's history keeps whatever it recorded.
    expect(messages[1]!.content).toBeNull();
  });

  it('leaves a tool-calling assistant turn null', () => {
    const calls = [{ id: 'c1', type: 'function' as const, function: { name: 'T', arguments: '{}' } }];
    const messages: ChatMessage[] = [user('hi'), { role: 'assistant', content: null, tool_calls: calls }];
    expect(sanitizeOutboundMessages(messages)[1]!.content).toBeNull();
  });

  it('returns the same array when nothing needs repair', () => {
    const messages: ChatMessage[] = [user('hi'), assistant('there')];
    expect(sanitizeOutboundMessages(messages)).toBe(messages);
  });
});

describe('completion usage extraction', () => {
  it('marks cached tokens known when prompt_tokens_details is present', () => {
    const usage = extractCompletionUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(usage).toEqual({
      promptTokens: 1000,
      completionTokens: 10,
      cachedTokens: 800,
      cachedTokensKnown: true,
    });
    expect(formatUsageLine(usage!)).toContain('cachedTok=800');
    expect(formatUsageLine(usage!)).toContain('cacheHitPct=80%');
  });

  it('marks cached tokens unknown when details are omitted', () => {
    const usage = extractCompletionUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(usage?.cachedTokensKnown).toBe(false);
    expect(usage?.cachedTokens).toBeUndefined();
    expect(formatUsageLine(usage!)).toContain('cachedTok=absent');
  });

  it('treats explicit cached_tokens 0 as known', () => {
    const usage = extractCompletionUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      cachedTokens: 0,
      cachedTokensKnown: true,
    });
  });
});
