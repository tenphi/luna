import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getContinuation, setContinuation } from './db/session-state.js';
import { getSessionClient, type UsageSummary, type UsageTotals } from './session/client.js';
import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import type { MessageInRow } from './db/messages-in.js';
import {
  commandArg,
  executeRunnerCommand,
  formatTokens,
  memoryFailure,
  parseRunnerCommand,
  runnerCommandMessages,
  runnerOutboundContent,
  setSessionsDirForTests,
  type RunnerCommandMessage,
} from './session-commands.js';
import type { RecallBridge } from './providers/openai/auto-recall.js';
import { saveHistory, setSessionsDirForTests as setStoreDir } from './providers/openai/session-store.js';
import { EPISODES_STATE_KEY, readEpisodes } from './providers/openai/episodes/ledger.js';

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    promptTokensCacheKnown: 0,
    turns: 0,
    ...overrides,
  };
}

/** Install a usage summary fixture on the in-memory session client. */
function seedUsage(parts: Partial<Omit<UsageSummary, 'updatedAt'>> & { updatedAt?: string | null }): void {
  const client = getSessionClient() as unknown as { usageSummary: UsageSummary | null };
  client.usageSummary = {
    today: parts.today ?? totals(),
    month: parts.month ?? parts.today ?? totals(),
    session: parts.session ?? totals(),
    topic: parts.topic ?? null,
    updatedAt: parts.updatedAt === undefined ? '2026-07-27T14:12:43.397Z' : parts.updatedAt,
  };
}

function chatMessage(text: string): MessageInRow {
  return {
    id: 'm1',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    platform_id: 'chan-1',
    channel_type: 'telegram',
    thread_id: null,
    content: JSON.stringify({ text }),
    trigger: 1,
    seq: 1,
  };
}

describe('session-commands', () => {
  let sessionsDir: string;

  beforeEach(() => {
    installTestSessionClient();
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-sessions-'));
    setSessionsDirForTests(sessionsDir);
    setStoreDir(sessionsDir);
  });

  afterEach(() => {
    setSessionsDirForTests(null);
    setStoreDir(null);
    resetTestSessionClient();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('parses /usage@mybot', () => {
    expect(parseRunnerCommand(chatMessage('/usage@mybot'))).toBe('/usage');
  });

  it('/clear clears the continuation', async () => {
    await setContinuation('openai', 'sess-1');

    const reply = await executeRunnerCommand('/clear', {
      providerName: 'openai',
      continuation: 'sess-1',
    });
    expect(reply).toBe('Session cleared.');
    expect(await getContinuation('openai')).toBeUndefined();
  });

  it('/clear archives the current topic when topics are on', async () => {
    saveHistory('sess-1', [
      { role: 'user', content: 'how do I get to Harbourtown' },
      { role: 'assistant', content: 'by bus' },
      { role: 'user', content: 'and back?' },
    ]);
    await getSessionClient().setSessionState(
      EPISODES_STATE_KEY,
      JSON.stringify([
        {
          id: 'ep_now',
          title: 'Blackwater Bay trip',
          emoji: '🏔️',
          historyId: 'sess-1',
          startedAt: '2026-07-27T10:00:00.000Z',
          lastActiveAt: '2026-07-27T11:00:00.000Z',
          summary: null,
          slugs: [],
        },
      ]),
    );

    const reply = await executeRunnerCommand('/clear', {
      providerName: 'openai',
      continuation: 'sess-1',
      episodesEnabled: true,
    });

    expect(reply).toContain('Archived 🏔️ Blackwater Bay trip');
    const episodes = await readEpisodes();
    expect(episodes).toHaveLength(2);
    expect(episodes[0]?.summary).toContain('Harbourtown');
    expect(episodes[0]?.exchanges).toBe(2);
    // The fresh episode is unnamed until the next message arrives.
    expect(episodes[1]?.title).toBe('New topic');
    expect(await getContinuation('openai')).toBe(episodes[1]!.historyId);
  });

  it('/clear stays a plain wipe when the session is not eligible for topics', async () => {
    await setContinuation('openai', 'sess-1');

    const reply = await executeRunnerCommand('/clear', {
      providerName: 'openai',
      continuation: 'sess-1',
      episodesEnabled: false,
    });

    expect(reply).toBe('Session cleared.');
    expect(await readEpisodes()).toEqual([]);
    expect(await getContinuation('openai')).toBeUndefined();
  });

  it('/topics lists topics newest first and marks the current one', async () => {
    await getSessionClient().setSessionState(
      EPISODES_STATE_KEY,
      JSON.stringify([
        {
          id: 'ep_old',
          title: 'Pasta recipes',
          emoji: '🍝',
          historyId: 'hist-old',
          startedAt: '2026-07-21T10:00:00.000Z',
          lastActiveAt: new Date(Date.now() - 90 * 60_000).toISOString(),
          summary: 'Anna asked for something quick.',
          slugs: [],
          conversationPage: 'conversations/2026-07-21-pasta-recipes',
        },
        {
          id: 'ep_now',
          title: 'Blackwater Bay trip',
          emoji: '🏔️',
          historyId: 'hist-now',
          startedAt: '2026-07-27T10:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          summary: null,
          slugs: [],
        },
      ]),
    );

    const reply = await executeRunnerCommand('/topics', {
      providerName: 'openai',
      episodesEnabled: true,
    });

    expect(reply.split('\n')).toEqual([
      '🏔️ Blackwater Bay trip — current',
      '🍝 Pasta recipes — 1h ago · conversations/2026-07-21-pasta-recipes',
    ]);
  });

  it('/topics says so when the session has topics off', async () => {
    const reply = await executeRunnerCommand('/topics', { providerName: 'openai', episodesEnabled: false });
    expect(reply).toBe('Topic tracking is off for this conversation.');
  });

  it('/learn off sets learn_enabled=false', async () => {
    const reply = await executeRunnerCommand('/learn', { providerName: 'openai' }, chatMessage('/learn off'));
    expect(reply).toContain('OFF');
    expect(await getSessionClient().getSessionState('learn_enabled')).toBe('false');
  });

  it('/learn on sets learn_enabled=true', async () => {
    const reply = await executeRunnerCommand('/learn', { providerName: 'openai' }, chatMessage('/learn on'));
    expect(reply).toContain('ON');
    expect(await getSessionClient().getSessionState('learn_enabled')).toBe('true');
  });

  it('bare /learn toggles the current state', async () => {
    await getSessionClient().setSessionState('learn_enabled', 'true');
    await executeRunnerCommand('/learn', { providerName: 'openai' }, chatMessage('/learn'));
    expect(await getSessionClient().getSessionState('learn_enabled')).toBe('false');
    await getSessionClient().setSessionState('learn_enabled', 'false');
    await executeRunnerCommand('/learn', { providerName: 'openai' }, chatMessage('/learn'));
    expect(await getSessionClient().getSessionState('learn_enabled')).toBe('true');
  });

  it('formats token counts by magnitude', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(128_400)).toBe('128.4k');
    expect(formatTokens(2_100_000)).toBe('2.1M');
  });

  it('/usage says so when nothing has been recorded', async () => {
    const reply = await executeRunnerCommand('/usage', { providerName: 'openai' });
    expect(reply).toBe('No usage recorded yet.');
  });

  it('/usage reports one stanza per period, tokens only', async () => {
    seedUsage({
      today: totals({ promptTokens: 128_400, completionTokens: 3200, cachedTokens: 61_000, promptTokensCacheKnown: 100_000, turns: 14 }),
      month: totals({ promptTokens: 2_100_000, completionTokens: 48_900, cachedTokens: 1_218_000, promptTokensCacheKnown: 2_100_000, turns: 214 }),
      session: totals({ promptTokens: 41_200, completionTokens: 1100, cachedTokens: 18_128, promptTokensCacheKnown: 41_200, turns: 4 }),
    });

    const reply = await executeRunnerCommand('/usage', { providerName: 'openai' });
    const lines = reply.split('\n').filter(Boolean);

    expect(lines[0]).toBe('📊 Usage');
    expect(lines).toContain('Today — 14 turns');
    expect(lines).toContain('in 128.4k · out 3.2k · cached 61%');
    expect(lines).toContain('This month — 214 turns');
    expect(lines).toContain('in 2.1M · out 48.9k · cached 58%');
    // No topic id passed, so the session line stands in for the topic line.
    expect(lines).toContain('This session — 4 turns');
    expect(reply).not.toMatch(/\$/);
    expect(reply).not.toMatch(/usd/i);
    expect(reply).not.toContain('2026-');
  });

  it('/usage divides the cache rate by cache-reporting prompt tokens only', async () => {
    // 900 of the 1000 prompt tokens came from turns with no cache details;
    // dividing by all of them would report 8% instead of the true 80%.
    seedUsage({
      today: totals({ promptTokens: 1000, completionTokens: 10, cachedTokens: 80, promptTokensCacheKnown: 100, turns: 2 }),
    });
    const reply = await executeRunnerCommand('/usage', { providerName: 'openai' });
    expect(reply).toContain('cached 80%');
  });

  it('/usage reports cache as unavailable when no turn had details', async () => {
    seedUsage({
      today: totals({ promptTokens: 500, completionTokens: 5, cachedTokens: 0, promptTokensCacheKnown: 0, turns: 1 }),
    });
    const reply = await executeRunnerCommand('/usage', { providerName: 'openai' });
    expect(reply).toContain('cached n/a');
  });

  it('/usage labels the topic stanza when topics are on', async () => {
    await getSessionClient().setSessionState(
      EPISODES_STATE_KEY,
      JSON.stringify([
        {
          id: 'ep_now',
          title: 'Blackwater Bay trip',
          emoji: '🏔️',
          historyId: 'hist-now',
          startedAt: '2026-07-27T10:00:00.000Z',
          lastActiveAt: '2026-07-27T11:00:00.000Z',
          summary: null,
          slugs: [],
        },
      ]),
    );
    seedUsage({
      today: totals({ turns: 5, promptTokens: 5000, promptTokensCacheKnown: 5000, cachedTokens: 2500 }),
      topic: totals({ turns: 2, promptTokens: 2000, promptTokensCacheKnown: 2000, cachedTokens: 500 }),
    });

    const reply = await executeRunnerCommand('/usage', {
      providerName: 'openai',
      episodesEnabled: true,
    });
    expect(reply).toContain('This topic — 2 turns · 🏔️ Blackwater Bay trip');
    expect(reply).not.toContain('This session —');
  });

  it('/usage reads a quiet period as "nothing yet" rather than a zero row', async () => {
    seedUsage({
      month: totals({ turns: 3, promptTokens: 3000, promptTokensCacheKnown: 3000, cachedTokens: 300 }),
    });
    const reply = await executeRunnerCommand('/usage', { providerName: 'openai' });
    expect(reply).toContain('Today — nothing yet');
    expect(reply).toContain('This month — 3 turns');
  });

  it('/compact compacts an active session', async () => {
    const sessionId = 'compact-test';
    await setContinuation('openai', sessionId);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `message ${i} `.repeat(20),
    }));
    saveHistory(sessionId, messages);

    const reply = await executeRunnerCommand('/compact', {
      providerName: 'openai',
      continuation: sessionId,
      contextConfig: { summarization: 'deterministic', keepRecentTurns: 2 },
    });
    expect(reply).toMatch(/^Context compacted/);
  });

  it('/context without session reports none', async () => {
    const reply = await executeRunnerCommand('/context', { providerName: 'openai' });
    expect(reply).toBe('No active session.');
  });
});

describe('runner command message fan-out', () => {
  it('turns a bare string into one plain message', () => {
    expect(runnerCommandMessages('hello')).toEqual([{ text: 'hello', plain: true }]);
  });

  it('drops messages that carry neither text nor files', () => {
    expect(runnerCommandMessages([{ text: '' }, { text: 'keep' }])).toEqual([{ text: 'keep' }]);
    expect(runnerCommandMessages([{ text: '', files: ['a.jpg'], id: 'msg-1' }])).toHaveLength(1);
  });

  it('serializes the legacy shape byte-for-byte', () => {
    // The eight pre-existing commands must keep emitting exactly this payload.
    expect(runnerOutboundContent({ text: 'Session cleared.', plain: true })).toBe(
      JSON.stringify({ text: 'Session cleared.', plain: true }),
    );
  });

  it('omits plain only when a message opts out, and passes files through', () => {
    expect(runnerOutboundContent({ text: 'x', plain: false })).toBe(JSON.stringify({ text: 'x' }));
    expect(runnerOutboundContent({ text: 'c', plain: true, files: ['a.pdf'], id: 'msg-1' })).toBe(
      JSON.stringify({ text: 'c', plain: true, files: ['a.pdf'] }),
    );
  });
});

describe('commandArg', () => {
  it('returns the text after the command token', () => {
    expect(commandArg('/read people/jane', '/read')).toBe('people/jane');
    expect(commandArg('  /read   people/jane  ', '/read')).toBe('people/jane');
    expect(commandArg('/read', '/read')).toBe('');
  });

  it('strips the @botname suffix Telegram adds in groups', () => {
    expect(commandArg('/read@lunabot people/jane', '/read')).toBe('people/jane');
    expect(commandArg('/learn@lunabot on', '/learn')).toBe('on');
  });
});
