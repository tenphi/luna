import { describe, it, expect } from 'bun:test';

import { createProvider, type ProviderName } from './factory.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai/index.js';

describe('createProvider', () => {
  it('returns OpenAIProvider for openai', () => {
    expect(createProvider('openai')).toBeInstanceOf(OpenAIProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });

  it('throws for claude (removed)', () => {
    expect(() => createProvider('claude' as ProviderName)).toThrow(/Unknown provider/);
  });
});
