import { describe, expect, it } from 'vitest';

import { parseChatArgv, shouldStartInteractiveChat } from './chat-client.js';

describe('parseChatArgv', () => {
  it('returns ask mode with joined message', () => {
    const parsed = parseChatArgv(['ask', 'hello', 'world']);
    expect(parsed).toEqual({
      mode: 'ask',
      message: 'hello world',
      timeoutMs: undefined,
      json: false,
      consumed: 3,
    });
  });

  it('parses ask flags', () => {
    const parsed = parseChatArgv(['ask', '--json', '--timeout', '5000', 'ping']);
    expect(parsed).toMatchObject({
      mode: 'ask',
      message: 'ping',
      timeoutMs: 5000,
      json: true,
    });
  });

  it('returns interactive for bare chat with no message when TTY', () => {
    const stdin = process.stdin.isTTY;
    const stdout = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      expect(parseChatArgv(['chat'])).toMatchObject({ mode: 'interactive' });
      expect(shouldStartInteractiveChat([])).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
    }
  });

  it('returns null for unknown commands', () => {
    expect(parseChatArgv(['groups', 'list'])).toBeNull();
  });
});
