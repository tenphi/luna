/**
 * Recognising a platform rate limit thrown by a channel adapter.
 *
 * Chat SDK adapters throw `AdapterRateLimitError` (name + optional `retryAfter`
 * in seconds) — e.g. the Telegram adapter maps Bot API 429s to it, carrying
 * `parameters.retry_after`. We can't `instanceof` it: the class lives in
 * `@chat-adapter/shared`, which is a transitive dep of whichever adapter
 * happens to be installed, and a channel skill can add adapters that resolve
 * their own copy. Matching on the name is the contract.
 *
 * The distinction matters because a rate limit is the one send failure that
 * says nothing about the message: it will succeed shortly, unchanged. Counting
 * it against the delivery attempt budget throws away a perfectly good reply
 * three 429s into a busy chat.
 */

/** Fallback when the platform rate-limits us without saying for how long. */
export const DEFAULT_RATE_LIMIT_RETRY_SEC = 5;

/**
 * Seconds to wait before retrying, or null when `err` isn't a rate limit.
 * Zero is a valid answer, so callers must check for null rather than falsiness.
 */
export function adapterRateLimitRetryAfterSec(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;

  const candidate = err as { name?: unknown; type?: unknown; retryAfter?: unknown };
  const isRateLimit = candidate.name === 'AdapterRateLimitError' || candidate.type === 'AdapterRateLimitError';
  if (!isRateLimit) return null;

  const retryAfter = candidate.retryAfter;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }
  return DEFAULT_RATE_LIMIT_RETRY_SEC;
}
