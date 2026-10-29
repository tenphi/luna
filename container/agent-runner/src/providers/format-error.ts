import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from 'openai';

export interface ProviderErrorContext {
  baseURL: string;
  model?: string;
}

export interface FormatOptions {
  detailed: boolean;
}

/** Luna-owned retry delays after the OpenAI SDK gives up (maxRetries: 0). */
export const CONNECTION_RETRY_DELAYS_SEC = [5, 10, 15] as const;

/** How many times to retry a 429 after the first failure (server-proposed delay each time). */
export const RATE_LIMIT_MAX_RETRIES = 3;
/** Fallback when the 429 has neither Retry-After headers nor a "try again in Xs" hint. */
export const RATE_LIMIT_DEFAULT_DELAY_SEC = 5;
/** Cap so a pathological Retry-After can't park the turn for minutes. */
export const RATE_LIMIT_MAX_DELAY_SEC = 60;

/**
 * How long a streaming completion may go without a single chunk before we give
 * up on it. A half-open connection or a wedged gateway keeps the socket alive
 * and simply stops sending, which no SDK timeout covers: the request never
 * errors, so the turn hangs until something else kills the container.
 *
 * Two minutes is far longer than any real inter-token gap (including
 * time-to-first-token on a loaded local model, which the watchdog keeps the
 * heartbeat alive through) and far shorter than "forever".
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Override in tests via LUNA_STREAM_IDLE_TIMEOUT_MS; 0 disables the watchdog. */
export function streamIdleTimeoutMs(): number {
  const raw = process.env.LUNA_STREAM_IDLE_TIMEOUT_MS;
  if (!raw) return STREAM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : STREAM_IDLE_TIMEOUT_MS;
}

/** A stream that stopped producing chunks without ending or erroring. */
export class StreamIdleError extends Error {
  readonly idleMs: number;

  constructor(idleMs: number) {
    super(`Model stream stalled — no data for ${Math.round(idleMs / 1000)}s`);
    this.name = 'StreamIdleError';
    this.idleMs = idleMs;
  }
}

export function isStreamIdleError(err: unknown): err is StreamIdleError {
  return err instanceof StreamIdleError;
}

/** Override in tests via LUNA_CONNECTION_RETRY_DELAYS_SEC=0,0,0 */
export function connectionRetryDelaysSec(): number[] {
  const raw = process.env.LUNA_CONNECTION_RETRY_DELAYS_SEC;
  if (!raw) return [...CONNECTION_RETRY_DELAYS_SEC];
  const parsed = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : [...CONNECTION_RETRY_DELAYS_SEC];
}

/** Override in tests via LUNA_RATE_LIMIT_MAX_RETRIES=1 */
export function rateLimitMaxRetries(): number {
  const raw = process.env.LUNA_RATE_LIMIT_MAX_RETRIES;
  if (!raw) return RATE_LIMIT_MAX_RETRIES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : RATE_LIMIT_MAX_RETRIES;
}

export function isConnectionError(err: unknown): boolean {
  return err instanceof APIConnectionError;
}

export function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitError || (err instanceof APIError && err.status === 429);
}

/**
 * A 5xx from the endpoint or a gateway in front of it (e.g. the OneCLI proxy
 * emitting "upstream connect error … connection termination"). Transient in
 * practice, so it shares the connection-retry budget.
 */
export function isServerError(err: unknown): boolean {
  return err instanceof APIError && err.status !== undefined && err.status >= 500;
}

function clampRateLimitDelaySec(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return RATE_LIMIT_DEFAULT_DELAY_SEC;
  return Math.min(RATE_LIMIT_MAX_DELAY_SEC, sec);
}

/**
 * Delay before retrying a 429. Prefer Retry-After / retry-after-ms headers, then
 * OpenAI's "Please try again in Xs" body text, else a short default.
 */
export function rateLimitRetryDelaySec(err: unknown): number {
  if (err instanceof APIError && err.headers && typeof err.headers.get === 'function') {
    const retryAfterMs = err.headers.get('retry-after-ms');
    if (retryAfterMs != null) {
      const ms = parseFloat(retryAfterMs);
      if (Number.isFinite(ms) && ms >= 0) return clampRateLimitDelaySec(ms / 1000);
    }
    const retryAfter = err.headers.get('retry-after');
    if (retryAfter != null) {
      const secs = parseFloat(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return clampRateLimitDelaySec(secs);
      const until = Date.parse(retryAfter);
      if (Number.isFinite(until)) return clampRateLimitDelaySec(Math.max(0, (until - Date.now()) / 1000));
    }
  }

  const msg = err instanceof Error ? err.message : String(err);
  const match = /try again in\s+([\d.]+)\s*s/i.exec(msg);
  if (match) {
    const secs = parseFloat(match[1]!);
    if (Number.isFinite(secs) && secs >= 0) return clampRateLimitDelaySec(secs);
  }

  return RATE_LIMIT_DEFAULT_DELAY_SEC;
}

export function unwrapCauseMessage(err: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < maxDepth && current != null; i++) {
    if (current instanceof Error) {
      if (current.message && !parts.includes(current.message)) parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === 'object' && 'message' in current) {
      const msg = String((current as { message: unknown }).message);
      if (msg && !parts.includes(msg)) parts.push(msg);
      break;
    } else {
      const s = String(current);
      if (s && !parts.includes(s)) parts.push(s);
      break;
    }
  }
  return parts.join(' → ');
}

export function redactBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.password = '';
    return u.toString();
  } catch {
    return (url.split('?')[0] ?? url).trim();
  }
}

function classifyCause(causeText: string): string | null {
  if (/ECONNREFUSED/i.test(causeText)) return 'connection refused';
  if (/ENOTFOUND|getaddrinfo/i.test(causeText)) return 'host not found';
  if (/ETIMEDOUT|timed out/i.test(causeText)) return 'timed out';
  if (/fetch failed/i.test(causeText)) return 'network request failed';
  return null;
}

function detailedEndpointHints(baseURL: string): string[] {
  const hints: string[] = [];
  const redacted = redactBaseUrl(baseURL);
  if (/localhost|127\.0\.0\.1/.test(redacted)) {
    hints.push(
      'From inside the container, use host.docker.internal instead of localhost to reach services on your Mac.',
    );
  }
  if (/:11434/.test(redacted)) {
    hints.push('If you use Ollama, make sure it is running.');
  }
  if (/api\.openai\.com/i.test(redacted)) {
    hints.push('Check your API key, billing, and OpenAI service status.');
  }
  hints.push('Ask your operator to check `providers.openai.baseUrl` with `luna config get`.');
  return hints;
}

/**
 * Log the raw provider error for the operator.
 *
 * Kept separate from `formatProviderError` on purpose: that one produces the
 * user-facing text and must stay a pure function, or every caller that formats
 * a message also emits a log line and one failure shows up in the log twice
 * under two different wordings.
 */
export function logProviderError(err: unknown): void {
  console.error(`[openai-provider] error: ${unwrapCauseMessage(err)}`);
}

export function formatConnectionRetryNotice(
  err: unknown,
  attempt: number,
  maxAttempts: number,
  delaySec: number,
  ctx: ProviderErrorContext,
  opts: FormatOptions,
): string {
  if (!opts.detailed) {
    return 'Having trouble responding — trying again…';
  }
  const base = redactBaseUrl(ctx.baseURL);
  if (isStreamIdleError(err)) {
    const idleSec = Math.round(err.idleMs / 1000);
    return `Model server at ${base} stopped sending after ${idleSec}s. Retrying in ${delaySec}s… (attempt ${attempt}/${maxAttempts})`;
  }
  if (isServerError(err)) {
    const status = (err as APIError).status;
    return `Model server at ${base} returned ${status}. Retrying in ${delaySec}s… (attempt ${attempt}/${maxAttempts})`;
  }
  const causeText = unwrapCauseMessage(err);
  const kind = classifyCause(causeText) ?? 'unreachable';
  return `Model server unreachable at ${base} (${kind}). Retrying in ${delaySec}s… (attempt ${attempt}/${maxAttempts})`;
}

function formatDelaySecLabel(delaySec: number): string {
  if (delaySec < 10) {
    const rounded = Math.round(delaySec * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }
  return String(Math.ceil(delaySec));
}

export function formatRateLimitRetryNotice(
  attempt: number,
  maxAttempts: number,
  delaySec: number,
  opts: FormatOptions,
): string {
  if (!opts.detailed) {
    return 'The model is busy — trying again…';
  }
  return `Rate limited. Retrying in ${formatDelaySecLabel(delaySec)}s… (attempt ${attempt}/${maxAttempts})`;
}

/**
 * The user-facing text for a failed turn.
 *
 * Unprivileged phrasing is deliberately first-person and consistent with the
 * host's own failure notices ("I couldn't finish that request", "I can't start
 * up right now"). It used to talk about "the AI service" in the third person,
 * which reads like a status page rather than the assistant the user is
 * speaking to, and pointed at "an admin" — a role this product dropped.
 */
export function formatProviderError(err: unknown, ctx: ProviderErrorContext, opts: FormatOptions): string {
  if (!opts.detailed) {
    if (err instanceof APIConnectionError) {
      return "I'm having trouble reaching the model right now. Please try again in a moment.";
    }
    if (err instanceof AuthenticationError) {
      return 'My model credentials were rejected — your operator needs to check the setup.';
    }
    if (err instanceof RateLimitError) {
      return 'The model is busy right now. Please try again in a moment.';
    }
    if (err instanceof APIError && err.status !== undefined && err.status >= 500) {
      return 'The model returned an error. Please try again in a moment.';
    }
    return 'Something went wrong while I was working on that. Please try again.';
  }

  const base = redactBaseUrl(ctx.baseURL);
  const causeText = unwrapCauseMessage(err);

  if (err instanceof APIConnectionTimeoutError) {
    return [
      `The model server at ${base} didn't respond in time.`,
      'It may be overloaded or unreachable from the container.',
      ...detailedEndpointHints(ctx.baseURL),
    ].join(' ');
  }

  if (err instanceof APIConnectionError) {
    const kind = classifyCause(causeText) ?? 'connection failed';
    return [
      `Couldn't reach the model server at ${base} (${kind}).`,
      ...detailedEndpointHints(ctx.baseURL),
    ].join(' ');
  }

  if (err instanceof AuthenticationError) {
    // The host's ChatGPT proxy has no API key; its 401 says what is wrong with the Codex login.
    if (/\/chatgpt\/?$/.test(ctx.baseURL)) return `ChatGPT subscription rejected the request: ${err.message}`;
    return `Model server rejected the API key (401). Check OPENAI_API_KEY and OneCLI vault credentials. Endpoint: ${base}`;
  }

  if (err instanceof RateLimitError) {
    const body = err.message && err.message !== '429' ? err.message : 'rate limit exceeded';
    return `Rate limited: ${body}`;
  }

  if (err instanceof APIError && err.status !== undefined && err.status >= 500) {
    return `Upstream error (${err.status}): ${causeText || err.message}`;
  }

  return causeText || (err instanceof Error ? err.message : String(err));
}

export async function sleepMsWithHeartbeat(ms: number, onTick?: () => void): Promise<void> {
  const chunk = 1000;
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(chunk, remaining);
    await new Promise((resolve) => setTimeout(resolve, step));
    onTick?.();
    remaining -= step;
  }
}
