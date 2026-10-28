import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';
import {
  clearContinuation,
  getContextSummary,
  getContinuation,
  setContextSummary,
  setContinuation,
} from './session-state.js';

beforeEach(() => {
  installTestSessionClient();
});

afterEach(() => {
  resetTestSessionClient();
});

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', async () => {
    await setContinuation('claude', 'claude-conv-1');
    expect(await getContinuation('claude')).toBe('claude-conv-1');
    expect(await getContinuation('Claude')).toBe('claude-conv-1');
    expect(await getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', async () => {
    await setContinuation('claude', 'claude-conv-1');
    await setContinuation('codex', 'codex-thread-xyz');

    expect(await getContinuation('claude')).toBe('claude-conv-1');
    expect(await getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', async () => {
    await setContinuation('claude', 'keep-me');
    await setContinuation('codex', 'drop-me');

    await clearContinuation('codex');

    expect(await getContinuation('claude')).toBe('keep-me');
    expect(await getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', async () => {
    expect(await getContinuation('never-used')).toBeUndefined();
  });

  test('clearContinuation also clears archived context summary', async () => {
    await setContinuation('openai', 'sess-1');
    await setContextSummary('openai', 'prior facts');
    await clearContinuation('openai');
    expect(await getContinuation('openai')).toBeUndefined();
    expect(await getContextSummary('openai')).toBeUndefined();
  });
});
