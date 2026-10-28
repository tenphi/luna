import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, initializeCentralSchema } from './index.js';
import { getUsageSummary, recordUsage, usageDayKey, type UsageDelta } from './usage.js';

const TZ = 'Europe/Berlin';

const BASE: UsageDelta = {
  agentGroupId: 'ag-1',
  sessionId: 'sess-1',
  episodeId: 'ep_a',
  provider: 'openai',
  model: 'gpt-5.6-luna',
};

function at(iso: string): Date {
  return new Date(iso);
}

beforeEach(() => {
  initializeCentralSchema(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('usageDayKey', () => {
  it('buckets by local midnight, not UTC midnight', () => {
    // 23:30 UTC on the 27th is already 01:30 on the 28th in Berlin.
    expect(usageDayKey(at('2026-07-27T23:30:00Z'), TZ)).toBe('2026-07-28');
    expect(usageDayKey(at('2026-07-27T23:30:00Z'), 'UTC')).toBe('2026-07-27');
  });

  it('keeps early-morning local time on the same local day', () => {
    expect(usageDayKey(at('2026-07-28T00:30:00Z'), TZ)).toBe('2026-07-28');
  });

  it('falls back to UTC for an invalid zone', () => {
    expect(usageDayKey(at('2026-07-27T23:30:00Z'), 'Not/AZone')).toBe('2026-07-27');
  });
});

describe('recordUsage', () => {
  it('accumulates repeated completions into one day bucket', () => {
    const now = at('2026-07-27T12:00:00Z');
    recordUsage({ ...BASE, promptTokens: 100, completionTokens: 20, cachedTokens: 60 }, TZ, now);
    recordUsage({ ...BASE, promptTokens: 300, completionTokens: 30, cachedTokens: 140 }, TZ, now);

    const { today } = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    expect(today).toEqual({
      promptTokens: 400,
      completionTokens: 50,
      cachedTokens: 200,
      promptTokensCacheKnown: 400,
      turns: 2,
    });
  });

  it('excludes turns without cache details from the cache-rate denominator', () => {
    const now = at('2026-07-27T12:00:00Z');
    recordUsage({ ...BASE, promptTokens: 100, completionTokens: 5, cachedTokens: 80 }, TZ, now);
    recordUsage(
      { ...BASE, promptTokens: 900, completionTokens: 5, cachedTokens: 0, cachedTokensKnown: false },
      TZ,
      now,
    );

    const { today } = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    // Both turns' prompt tokens count, but only the reporting turn's do for cache.
    expect(today.promptTokens).toBe(1000);
    expect(today.promptTokensCacheKnown).toBe(100);
    expect(today.cachedTokens).toBe(80);
    expect(today.turns).toBe(2);
  });
});

describe('getUsageSummary', () => {
  const now = at('2026-07-27T12:00:00Z');

  beforeEach(() => {
    // Yesterday, same session/topic.
    recordUsage(
      { ...BASE, promptTokens: 1000, completionTokens: 100, cachedTokens: 500 },
      TZ,
      at('2026-07-26T12:00:00Z'),
    );
    // Last month — inside session totals, outside the month bucket.
    recordUsage({ ...BASE, promptTokens: 7, completionTokens: 7, cachedTokens: 7 }, TZ, at('2026-06-30T12:00:00Z'));
    // Today, this topic.
    recordUsage({ ...BASE, promptTokens: 200, completionTokens: 20, cachedTokens: 100 }, TZ, now);
    // Today, same session but a different topic.
    recordUsage({ ...BASE, episodeId: 'ep_b', promptTokens: 50, completionTokens: 5, cachedTokens: 25 }, TZ, now);
    // Today, a different session entirely (CLI) — counts toward today/month only.
    recordUsage(
      { ...BASE, sessionId: 'sess-2', episodeId: '', promptTokens: 30, completionTokens: 3, cachedTokens: 15 },
      TZ,
      now,
    );
  });

  it('sums today across every session', () => {
    const { today } = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    expect(today.promptTokens).toBe(280);
    expect(today.turns).toBe(3);
  });

  it('sums the month across every session but excludes other months', () => {
    const { month } = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    expect(month.promptTokens).toBe(1280);
    expect(month.turns).toBe(4);
  });

  it('scopes the session total to one session, across all days', () => {
    const { session } = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    expect(session.promptTokens).toBe(1257);
    expect(session.turns).toBe(4);
  });

  it('scopes the topic total to one episode of one session', () => {
    const { topic } = getUsageSummary({ sessionId: 'sess-1', episodeId: 'ep_a' }, TZ, now);
    expect(topic?.promptTokens).toBe(1207);
    expect(topic?.turns).toBe(3);
  });

  it('returns no topic total when no episode is given', () => {
    expect(getUsageSummary({ sessionId: 'sess-1' }, TZ, now).topic).toBeNull();
    expect(getUsageSummary({ sessionId: 'sess-1', episodeId: '  ' }, TZ, now).topic).toBeNull();
  });

  it('reports zeroes and a null timestamp for an empty ledger', () => {
    closeDb();
    initializeCentralSchema(initTestDb());
    const summary = getUsageSummary({ sessionId: 'sess-1' }, TZ, now);
    expect(summary.today.turns).toBe(0);
    expect(summary.month.promptTokens).toBe(0);
    expect(summary.updatedAt).toBeNull();
  });

  it('reports the most recent activity timestamp', () => {
    expect(getUsageSummary({ sessionId: 'sess-1' }, TZ, now).updatedAt).toBe(now.toISOString());
  });
});
