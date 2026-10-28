import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { saveHistory, setSessionsDirForTests } from '../session-store.js';
import type { ChatMessage } from '../types.js';
import { resolveTopicsConfig } from './config.js';
import { appendEpisode, readEpisodes, updateEpisode } from './ledger.js';
import { conversationSlug } from './mirror.js';
import {
  compactIfOverBudgetWithSummary,
  drainEpisodeSummaries,
  formatSummaryBody,
  summarizeTranscript,
  type SummaryChatFn,
} from './summarize.js';

const GOOD_REPLY = JSON.stringify({
  title: 'Blackwater Bay trip planning',
  emoji: '🏔️',
  summary: 'On 25 July Ada asked me to plan five nights in Harbourtown. We settled on the coastal route.',
  openThreads: ['book the ferry from Eastport'],
});

function transcript(turns = 3): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: 'user', content: `question ${i} about Harbourtown` });
    history.push({ role: 'assistant', content: `answer ${i}` });
  }
  return history;
}

describe('summarizeTranscript', () => {
  it('returns the parsed summary and sanitizes title and emoji', async () => {
    const chat: SummaryChatFn = async () =>
      JSON.stringify({ title: '  "Blackwater Bay trip"  ', emoji: '🏔️ mountains', summary: 'We settled on Harbourtown.' });

    const summary = await summarizeTranscript(transcript(), { chat });

    expect(summary).toEqual({
      title: 'Blackwater Bay trip',
      emoji: '🏔️',
      summary: 'We settled on Harbourtown.',
      openThreads: [],
    });
  });

  it('caps open threads at three and drops non-strings', async () => {
    const chat: SummaryChatFn = async () =>
      JSON.stringify({ title: 'T', emoji: '📌', summary: 'S', openThreads: ['a', 'b', 2, 'c', 'd'] });

    const summary = await summarizeTranscript(transcript(), { chat });

    expect(summary?.openThreads).toEqual(['a', 'b', 'c']);
  });

  it('sends the transcript and asks for participant-attributed prose', async () => {
    let system = '';
    let user = '';
    const chat: SummaryChatFn = async (messages) => {
      system = messages[0]?.content ?? '';
      user = messages[1]?.content ?? '';
      return GOOD_REPLY;
    };

    await summarizeTranscript(transcript(1), { chat });

    expect(system).toContain('Never assert a bare fact about the world');
    expect(user).toContain('question 0 about Harbourtown');
  });

  it('asks for the record in English whatever the conversation language', async () => {
    let system = '';
    const chat: SummaryChatFn = async (messages) => {
      system = messages[0]?.content ?? '';
      return GOOD_REPLY;
    };

    await summarizeTranscript(transcript(1), { chat });

    expect(system).toContain('in ENGLISH, whatever language the conversation was in');
    expect(system).toContain('Keep names, place names, and short verbatim quotes');
  });

  it('returns null for an empty history, unusable output, or a thrown call', async () => {
    expect(await summarizeTranscript([], { chat: async () => GOOD_REPLY })).toBeNull();
    expect(await summarizeTranscript(transcript(), { chat: async () => null })).toBeNull();
    expect(await summarizeTranscript(transcript(), { chat: async () => 'not json' })).toBeNull();
    expect(await summarizeTranscript(transcript(), { chat: async () => '{"title":"T"}' })).toBeNull();
    expect(
      await summarizeTranscript(transcript(), {
        chat: async () => {
          throw new Error('endpoint down');
        },
      }),
    ).toBeNull();
  });

  it('uses the main model when asked', async () => {
    let mainCalled = false;
    const host = {
      completeTurn: async () => {
        mainCalled = true;
        return { text: GOOD_REPLY, toolCalls: [] };
      },
    };

    const summary = await summarizeTranscript(transcript(), {
      summaryModel: 'main',
      host,
      chat: async () => {
        throw new Error('memory model must not be used');
      },
    });

    expect(mainCalled).toBe(true);
    expect(summary?.title).toBe('Blackwater Bay trip planning');
  });
});

describe('formatSummaryBody', () => {
  it('appends open threads to the prose', () => {
    expect(
      formatSummaryBody({ title: 'T', emoji: '📌', summary: 'We settled on Harbourtown.', openThreads: ['book ferry'] }),
    ).toBe('We settled on Harbourtown.\nOpen: book ferry');
  });

  it('leaves prose alone when nothing is pending', () => {
    expect(formatSummaryBody({ title: 'T', emoji: '📌', summary: 'Done.', openThreads: [] })).toBe('Done.');
  });
});

describe('drainEpisodeSummaries', () => {
  let sessionsDir: string;

  beforeEach(() => {
    setSessionClient(new InMemorySessionClient());
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-summary-'));
    setSessionsDirForTests(sessionsDir);
  });

  afterEach(() => {
    setSessionsDirForTests(null);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  const topics = resolveTopicsConfig();

  /** A closed episode with enough substance to earn a summary. */
  async function closedEpisode(overrides: { exchanges?: number; slugs?: string[] } = {}) {
    saveHistory('hist-closed', transcript());
    const episode = await appendEpisode({ title: 'Provisional', emoji: '💬', historyId: 'hist-closed' });
    await updateEpisode(episode.id, {
      summary: 'user: question 0 about Harbourtown',
      exchanges: overrides.exchanges ?? 3,
      slugs: overrides.slugs ?? [],
    });
    // Tail entry = current episode, so the closed one needs a successor.
    await appendEpisode({ title: 'Current', emoji: '💬', historyId: 'hist-current' });
    return episode;
  }

  it('replaces the provisional summary and renames the episode', async () => {
    const episode = await closedEpisode();

    const n = await drainEpisodeSummaries({ topics, chat: async () => GOOD_REPLY });

    expect(n).toBe(1);
    const stored = (await readEpisodes()).find((e) => e.id === episode.id);
    expect(stored?.title).toBe('Blackwater Bay trip planning');
    expect(stored?.emoji).toBe('🏔️');
    expect(stored?.summary).toContain('Open: book the ferry from Eastport');
    expect(stored?.summarizedAt).toBeDefined();
  });

  it('never summarizes the current episode', async () => {
    saveHistory('hist-current', transcript());
    const current = await appendEpisode({ title: 'Current', emoji: '💬', historyId: 'hist-current' });
    await updateEpisode(current.id, { exchanges: 5 });

    const n = await drainEpisodeSummaries({
      topics,
      chat: async () => {
        throw new Error('must not be called');
      },
    });

    expect(n).toBe(0);
  });

  it('skips trivial episodes so one-shot questions stay out of memory', async () => {
    await closedEpisode({ exchanges: 1, slugs: [] });

    const n = await drainEpisodeSummaries({
      topics,
      chat: async () => {
        throw new Error('must not be called');
      },
    });

    expect(n).toBe(0);
  });

  it('summarizes a one-shot episode that touched memory', async () => {
    await closedEpisode({ exchanges: 1, slugs: ['people/anna'] });

    expect(await drainEpisodeSummaries({ topics, chat: async () => GOOD_REPLY })).toBe(1);
  });

  it('keeps the provisional summary and retries when the model is unavailable', async () => {
    const episode = await closedEpisode();

    expect(await drainEpisodeSummaries({ topics, chat: async () => null })).toBe(0);

    const stored = (await readEpisodes()).find((e) => e.id === episode.id);
    expect(stored?.summary).toBe('user: question 0 about Harbourtown');
    expect(stored?.summarizedAt).toBeUndefined();
  });

  it('stops retrying an episode whose history file is gone', async () => {
    const episode = await closedEpisode();
    fs.rmSync(path.join(sessionsDir, 'hist-closed.json'));

    expect(await drainEpisodeSummaries({ topics, chat: async () => GOOD_REPLY })).toBe(0);
    expect((await readEpisodes()).find((e) => e.id === episode.id)?.summarizedAt).toBeDefined();
  });

  it('hands the summarized episode to the mirror hook', async () => {
    await closedEpisode({ slugs: ['travel/blackwater-bay-plan'] });
    const mirrored: string[] = [];

    await drainEpisodeSummaries({
      topics,
      chat: async () => GOOD_REPLY,
      onSummarized: async (episode, summary) => {
        mirrored.push(`${conversationSlug(episode)}::${summary.title}`);
      },
    });

    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toContain('conversations/');
    expect(mirrored[0]).toContain('-blackwater-bay-trip-planning::Blackwater Bay trip planning');
  });

  it('does nothing when topics are disabled', async () => {
    await closedEpisode();

    const n = await drainEpisodeSummaries({
      topics: resolveTopicsConfig({ enabled: false }),
      chat: async () => {
        throw new Error('must not be called');
      },
    });

    expect(n).toBe(0);
  });
});

describe('compactIfOverBudgetWithSummary', () => {
  const overBudget = { maxApproxTokens: 1, keepRecentTurns: 2 } as const;

  it('uses the model summary for the compacted region', async () => {
    const result = await compactIfOverBudgetWithSummary(
      transcript(8),
      { ...overBudget, summarization: 'model' },
      { chat: async () => GOOD_REPLY },
    );

    expect(result.compacted).toBe(true);
    expect(result.summaryText).toContain('We settled on the coastal route.');
    expect(result.history[0]?.content).toContain('<conversation_summary>');
  });

  it('falls back to the deterministic summary when the model is unavailable', async () => {
    const result = await compactIfOverBudgetWithSummary(
      transcript(8),
      { ...overBudget, summarization: 'model' },
      { chat: async () => null },
    );

    expect(result.compacted).toBe(true);
    expect(result.summaryText).toContain('user: question 0 about Harbourtown');
  });

  it('never calls the model in deterministic mode or under budget', async () => {
    const boom: SummaryChatFn = async () => {
      throw new Error('must not be called');
    };

    const deterministic = await compactIfOverBudgetWithSummary(
      transcript(8),
      { ...overBudget, summarization: 'deterministic' },
      { chat: boom },
    );
    expect(deterministic.compacted).toBe(true);

    const underBudget = await compactIfOverBudgetWithSummary(
      transcript(2),
      { maxApproxTokens: 10_000, summarization: 'model' },
      { chat: boom },
    );
    expect(underBudget.compacted).toBe(false);
  });
});
