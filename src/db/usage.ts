/**
 * Token usage ledger (`usage_daily` in the central DB).
 *
 * The container reports one row per completion through the Session API; `/usage`
 * reads back the periods a human actually asks about. Central rather than
 * per-session, so "today" and "this month" span Telegram, CLI and ephemeral
 * `luna ask` alike instead of splitting per `session.db`.
 */
import { getDb } from './connection.js';
import { resolveTimezone } from '../timezone.js';

export interface UsageDelta {
  agentGroupId: string;
  sessionId: string;
  /** '' when topic segmentation is off for the session. */
  episodeId?: string | null;
  provider: string;
  model?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** False when the endpoint omitted `prompt_tokens_details` for this completion. */
  cachedTokensKnown?: boolean;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Prompt tokens of turns that reported cache details — the cache-rate denominator. */
  promptTokensCacheKnown: number;
  turns: number;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  session: UsageTotals;
  /** Null when the caller passed no episode id (topics off). */
  topic: UsageTotals | null;
  /** Most recent recorded activity across the whole install, ISO. */
  updatedAt: string | null;
}

const ZERO: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  promptTokensCacheKnown: 0,
  turns: 0,
};

/**
 * `YYYY-MM-DD` for `at` in `timezone`. Buckets follow local midnight — bucketing
 * in UTC would roll "today" over at 02:00 in Berlin.
 */
export function usageDayKey(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface UsageRow {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  prompt_tokens_cache_known: number | null;
  turns: number | null;
}

function toTotals(row: UsageRow | undefined): UsageTotals {
  if (!row) return { ...ZERO };
  return {
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    cachedTokens: row.cached_tokens ?? 0,
    promptTokensCacheKnown: row.prompt_tokens_cache_known ?? 0,
    turns: row.turns ?? 0,
  };
}

const SUM_COLUMNS = `
  SUM(prompt_tokens)             AS prompt_tokens,
  SUM(completion_tokens)         AS completion_tokens,
  SUM(cached_tokens)             AS cached_tokens,
  SUM(prompt_tokens_cache_known) AS prompt_tokens_cache_known,
  SUM(turns)                     AS turns
`;

/** Fold one completion's usage into its day bucket. */
export function recordUsage(delta: UsageDelta, timezone: string, now: Date = new Date()): void {
  const cacheKnown = delta.cachedTokensKnown !== false;
  const promptTokens = delta.promptTokens ?? 0;

  getDb()
    .prepare(
      `INSERT INTO usage_daily (
         day, agent_group_id, session_id, episode_id, provider, model,
         prompt_tokens, completion_tokens, cached_tokens, prompt_tokens_cache_known,
         turns, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (day, agent_group_id, session_id, episode_id, provider, model)
       DO UPDATE SET
         prompt_tokens             = prompt_tokens + excluded.prompt_tokens,
         completion_tokens         = completion_tokens + excluded.completion_tokens,
         cached_tokens             = cached_tokens + excluded.cached_tokens,
         prompt_tokens_cache_known = prompt_tokens_cache_known + excluded.prompt_tokens_cache_known,
         turns                     = turns + 1,
         updated_at                = excluded.updated_at`,
    )
    .run(
      usageDayKey(now, timezone),
      delta.agentGroupId,
      delta.sessionId,
      delta.episodeId ?? '',
      delta.provider,
      delta.model ?? '',
      promptTokens,
      delta.completionTokens ?? 0,
      cacheKnown ? (delta.cachedTokens ?? 0) : 0,
      cacheKnown ? promptTokens : 0,
      now.toISOString(),
    );
}

/**
 * Today / this month (install-wide) plus this session and, when an episode id
 * is given, this topic. Month is a `day LIKE 'YYYY-MM-%'` prefix match, which
 * is exact for the `YYYY-MM-DD` format and stays on the primary key.
 */
export function getUsageSummary(
  scope: { sessionId: string; episodeId?: string | null },
  timezone: string,
  now: Date = new Date(),
): UsageSummary {
  const db = getDb();
  const day = usageDayKey(now, timezone);
  const month = day.slice(0, 7);

  const today = db.prepare(`SELECT ${SUM_COLUMNS} FROM usage_daily WHERE day = ?`).get(day) as UsageRow | undefined;
  const monthRow = db.prepare(`SELECT ${SUM_COLUMNS} FROM usage_daily WHERE day LIKE ?`).get(`${month}-%`) as
    UsageRow | undefined;
  const session = db.prepare(`SELECT ${SUM_COLUMNS} FROM usage_daily WHERE session_id = ?`).get(scope.sessionId) as
    UsageRow | undefined;

  const episodeId = scope.episodeId?.trim();
  const topic = episodeId
    ? (db
        .prepare(`SELECT ${SUM_COLUMNS} FROM usage_daily WHERE session_id = ? AND episode_id = ?`)
        .get(scope.sessionId, episodeId) as UsageRow | undefined)
    : undefined;

  const latest = db.prepare('SELECT MAX(updated_at) AS updated_at FROM usage_daily').get() as
    { updated_at: string | null } | undefined;

  return {
    today: toTotals(today),
    month: toTotals(monthRow),
    session: toTotals(session),
    topic: episodeId ? toTotals(topic) : null,
    updatedAt: latest?.updated_at ?? null,
  };
}
