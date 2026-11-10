import { describe, it, expect, spyOn } from 'bun:test';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from 'openai';

import {
  formatConnectionRetryNotice,
  formatProviderError,
  formatRateLimitRetryNotice,
  isTransientStreamError,
  logProviderError,
  ResponsesStreamError,
  rateLimitRetryDelaySec,
  redactBaseUrl,
  unwrapCauseMessage,
} from './format-error.js';

const ctx = { baseURL: 'http://host.docker.internal:11434/v1', model: 'test' };
/** What the SDK raises for a streamed event that carries an `error` object, as the ChatGPT backend sends an overload. */
const streamOverload = new APIError(
  undefined,
  {
    type: 'service_unavailable_error',
    code: 'server_is_overloaded',
    message: 'Our servers are currently overloaded. Please try again later.',
  },
  undefined,
  undefined,
);

describe('formatProviderError', () => {
  it('detailed connection error mentions endpoint and Ollama hint', () => {
    const err = new APIConnectionError({
      cause: new Error('connect ECONNREFUSED 127.0.0.1:11434'),
    });
    const msg = formatProviderError(err, ctx, { detailed: true });
    expect(msg).toContain('host.docker.internal:11434');
    expect(msg).toContain('connection refused');
    expect(msg).toContain('Ollama');
    expect(msg).toContain('luna config get');
  });

  it('simplified connection error hides technical detail', () => {
    const err = new APIConnectionError({ cause: new Error('connect ECONNREFUSED') });
    const msg = formatProviderError(err, ctx, { detailed: false });
    expect(msg).toContain('having trouble');
    expect(msg).not.toContain('11434');
    expect(msg).not.toContain('OPENAI');
  });

  it('detailed timeout error mentions endpoint', () => {
    const err = new APIConnectionTimeoutError();
    const msg = formatProviderError(err, ctx, { detailed: true });
    expect(msg).toContain("didn't respond in time");
    expect(msg).toContain('host.docker.internal:11434');
  });

  it('detailed auth error mentions API key', () => {
    const err = new AuthenticationError(401, undefined, 'invalid key', undefined);
    const msg = formatProviderError(err, ctx, { detailed: true });
    expect(msg).toContain('401');
    expect(msg).toContain('OPENAI_API_KEY');
  });

  it('detailed auth error through the ChatGPT proxy explains the login, not an API key', () => {
    const err = new AuthenticationError(401, { message: 'The ChatGPT login has expired.' }, undefined, undefined);
    const msg = formatProviderError(
      err,
      { baseURL: 'http://host.docker.internal:18800/session/g/s/chatgpt', model: 'gpt-6-luna' },
      { detailed: true },
    );
    expect(msg).toContain('ChatGPT login has expired');
    expect(msg).not.toContain('OPENAI_API_KEY');
  });

  it('simplified auth error is generic', () => {
    const err = new AuthenticationError(401, undefined, 'invalid key', undefined);
    const msg = formatProviderError(err, ctx, { detailed: false });
    expect(msg).toContain('operator');
    expect(msg).not.toContain('OPENAI_API_KEY');
  });

  it('simplified rate limit is generic', () => {
    const err = new RateLimitError(429, undefined, 'too many', undefined);
    const msg = formatProviderError(err, ctx, { detailed: false });
    expect(msg).toContain('busy');
    expect(msg).not.toContain('429');
  });

  it('an overload reported inside the stream says the model is busy', () => {
    expect(formatProviderError(streamOverload, ctx, { detailed: false })).toBe(
      'The model is busy right now. Please try again in a moment.',
    );
    expect(formatProviderError(streamOverload, ctx, { detailed: true })).toBe(
      'Upstream error mid-response: Our servers are currently overloaded. Please try again later.',
    );
  });

  it('another transient stream failure says the model returned an error', () => {
    const msg = formatProviderError(new ResponsesStreamError('server_error'), ctx, { detailed: false });
    expect(msg).toBe('The model returned an error. Please try again in a moment.');
  });
});

describe('isTransientStreamError', () => {
  it('retries failures the provider reports inside the stream', () => {
    expect(isTransientStreamError(streamOverload)).toBe(true);
    expect(isTransientStreamError(new ResponsesStreamError('server_error'))).toBe(true);
    expect(isTransientStreamError(new ResponsesStreamError())).toBe(true);
  });

  it('does not retry what the same request would hit again', () => {
    expect(isTransientStreamError(new ResponsesStreamError('context_length_exceeded'))).toBe(false);
    const invalid = new APIError(
      undefined,
      { type: 'invalid_request_error', message: 'Invented' },
      undefined,
      undefined,
    );
    expect(isTransientStreamError(invalid)).toBe(false);
  });

  it('leaves connection, abort and HTTP errors to their own checks', () => {
    expect(isTransientStreamError(new APIConnectionError({ cause: new Error('ECONNREFUSED') }))).toBe(false);
    expect(isTransientStreamError(new APIUserAbortError())).toBe(false);
    expect(isTransientStreamError(new APIError(503, { message: 'unavailable' }, undefined, undefined))).toBe(false);
    expect(isTransientStreamError(new Error('Responses request was incomplete'))).toBe(false);
  });
});

describe('formatConnectionRetryNotice', () => {
  it('detailed retry notice includes attempt and delay', () => {
    const err = new APIConnectionError({ cause: new Error('ECONNREFUSED') });
    const msg = formatConnectionRetryNotice(err, 1, 3, 5, ctx, { detailed: true });
    expect(msg).toContain('Retrying in 5s');
    expect(msg).toContain('attempt 1/3');
    expect(msg).toContain('connection refused');
    expect(msg).toContain('host.docker.internal:11434');
  });

  it('detailed retry notice names an overload reported inside the stream', () => {
    const msg = formatConnectionRetryNotice(streamOverload, 1, 3, 5, ctx, { detailed: true });
    expect(msg).toBe(
      'Model server at http://host.docker.internal:11434/v1 is overloaded. Retrying in 5s… (attempt 1/3)',
    );
  });

  it('simplified retry notice is short', () => {
    const err = new APIConnectionError({ cause: new Error('ECONNREFUSED') });
    const msg = formatConnectionRetryNotice(err, 2, 3, 10, ctx, { detailed: false });
    expect(msg).toBe('Having trouble responding — trying again…');
  });
});

describe('rateLimitRetryDelaySec', () => {
  it('parses "Please try again in Xs" from the error body', () => {
    const err = new RateLimitError(
      429,
      {
        message:
          'Rate limit reached for gpt-5.6-luna on tokens per min (TPM): Limit 200000, Used 192688, Requested 22164. Please try again in 4.455s.',
      },
      undefined,
      undefined,
    );
    expect(rateLimitRetryDelaySec(err)).toBeCloseTo(4.455, 3);
  });

  it('prefers retry-after-ms header over body text', () => {
    const headers = new Headers({ 'retry-after-ms': '2500' });
    const err = new RateLimitError(
      429,
      { message: 'Please try again in 9.9s.' },
      undefined,
      headers,
    );
    expect(rateLimitRetryDelaySec(err)).toBeCloseTo(2.5, 3);
  });

  it('uses retry-after seconds when present', () => {
    const headers = new Headers({ 'retry-after': '7' });
    const err = new RateLimitError(429, { message: 'rate limited' }, undefined, headers);
    expect(rateLimitRetryDelaySec(err)).toBe(7);
  });

  it('falls back to a default delay', () => {
    const err = new RateLimitError(429, { message: 'too many requests' }, undefined, undefined);
    expect(rateLimitRetryDelaySec(err)).toBe(5);
  });

  it('caps pathological delays', () => {
    const headers = new Headers({ 'retry-after': '999' });
    const err = new RateLimitError(429, undefined, undefined, headers);
    expect(rateLimitRetryDelaySec(err)).toBe(60);
  });
});

describe('formatRateLimitRetryNotice', () => {
  it('detailed notice includes attempt and delay', () => {
    const msg = formatRateLimitRetryNotice(1, 3, 4.455, { detailed: true });
    expect(msg).toContain('Rate limited');
    expect(msg).toContain('Retrying in 4.5s');
    expect(msg).toContain('attempt 1/3');
  });

  it('simplified notice is short', () => {
    expect(formatRateLimitRetryNotice(2, 3, 5, { detailed: false })).toBe(
      'The model is busy — trying again…',
    );
  });
});

describe('unwrapCauseMessage', () => {
  it('walks the cause chain', () => {
    const leaf = new Error('connect ECONNREFUSED');
    const err = new APIConnectionError({ cause: leaf });
    expect(unwrapCauseMessage(err)).toContain('Connection error');
    expect(unwrapCauseMessage(err)).toContain('ECONNREFUSED');
  });
});

describe('redactBaseUrl', () => {
  it('strips query strings', () => {
    expect(redactBaseUrl('http://example.com/v1?key=secret')).toBe('http://example.com/v1');
  });
});

describe('logProviderError', () => {
  // The host logs only the final `error:` line as an error (src/container-runner.ts).
  function logged(opts?: { retrying?: boolean }): string {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      logProviderError(new Error('503 overloaded'), opts);
      return String(spy.mock.calls[0]?.[0]);
    } finally {
      spy.mockRestore();
    }
  }

  it('marks a failure the caller gives up on as an error', () => {
    expect(logged()).toBe('[openai-provider] error: 503 overloaded');
  });

  it('marks a failure the caller will retry differently', () => {
    expect(logged({ retrying: true })).toBe('[openai-provider] retrying after error: 503 overloaded');
  });
});
