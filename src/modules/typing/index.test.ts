/**
 * Typing indicator refresh — working-gate tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressSession, destroyProgressSession, type ProgressSink } from '../../progress/controller.js';
import { clearLiveness, recordPing } from '../../session-liveness.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

const SESSION = 'typing-test-session';
const AGENT = 'agent-group';

function makeSink(): ProgressSink {
  return {
    isCli: false,
    async sendStatus() {
      return 'msg-1';
    },
    async editStatus() {},
  };
}

describe('typing refresh working gate', () => {
  let typingCalls: Array<{ channelType: string; platformId: string; threadId: string | null }>;

  beforeEach(() => {
    vi.useFakeTimers();
    typingCalls = [];
    destroyProgressSession(SESSION);
    clearLiveness(SESSION);
    stopTypingRefresh(SESSION);
    setTypingAdapter({
      async setTyping(channelType, platformId, threadId) {
        typingCalls.push({ channelType, platformId, threadId });
      },
    });
  });

  afterEach(() => {
    stopTypingRefresh(SESSION);
    destroyProgressSession(SESSION);
    clearLiveness(SESSION);
    vi.useRealTimers();
  });

  it('fires immediately on start', () => {
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    expect(typingCalls).toHaveLength(1);
  });

  it('keeps typing during grace even without heartbeat', () => {
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    typingCalls = [];
    vi.advanceTimersByTime(4000);
    expect(typingCalls.length).toBeGreaterThan(0);
  });

  it('stops after grace when only idle heartbeats land (no progress turn)', () => {
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    // Idle poll would keep pinging like this:
    const idle = setInterval(() => recordPing(SESSION), 1000);
    vi.advanceTimersByTime(16_000); // past grace
    typingCalls = [];
    vi.advanceTimersByTime(8000);
    clearInterval(idle);
    expect(typingCalls).toHaveLength(0);
  });

  it('keeps typing after grace while a progress turn is open and heartbeat is fresh', () => {
    createProgressSession(SESSION, Date.now(), makeSink());
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    // Stay "working" across the grace boundary so the refresher doesn't exit.
    const keepAlive = setInterval(() => recordPing(SESSION), 2000);
    vi.advanceTimersByTime(16_000);
    typingCalls = [];
    recordPing(SESSION);
    vi.advanceTimersByTime(4000);
    clearInterval(keepAlive);
    expect(typingCalls.length).toBeGreaterThan(0);
  });

  it('keeps typing while a tool is in flight even if lastSeen is stale', () => {
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    // Mark the tool before grace ends so the refresher stays alive.
    vi.advanceTimersByTime(14_000);
    recordPing(SESSION, {
      setTool: true,
      tool: 'list_calendar_events',
      toolDeclaredTimeoutMs: null,
      toolStartedAt: new Date().toISOString(),
    });
    // Age lastSeen past HEARTBEAT_FRESH_MS without clearing the tool.
    vi.advanceTimersByTime(10_000);
    typingCalls = [];
    vi.advanceTimersByTime(4000);
    expect(typingCalls.length).toBeGreaterThan(0);
  });

  it('resumes after a short post-delivery pause while still working', () => {
    createProgressSession(SESSION, Date.now(), makeSink());
    startTypingRefresh(SESSION, AGENT, 'telegram', 'telegram:1', null);
    const keepAlive = setInterval(() => recordPing(SESSION), 2000);
    vi.advanceTimersByTime(16_000);
    pauseTypingRefreshAfterDelivery(SESSION);
    typingCalls = [];
    vi.advanceTimersByTime(1000); // still paused (1.5s)
    expect(typingCalls).toHaveLength(0);
    recordPing(SESSION);
    vi.advanceTimersByTime(4000); // pause expired + tick
    clearInterval(keepAlive);
    expect(typingCalls.length).toBeGreaterThan(0);
  });
});
