import { describe, it, expect } from 'bun:test';
import { APIConnectionError, APIConnectionTimeoutError, AuthenticationError, RateLimitError } from 'openai';

import {
  formatConnectionRetryNotice,
  formatProviderError,
  formatRateLimitRetryNotice,
  rateLimitRetryDelaySec,
  redactBaseUrl,
  unwrapCauseMessage,
} from './format-error.js';

const ctx = { baseURL: 'http://host.docker.internal:11434/v1', model: 'test' };

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
