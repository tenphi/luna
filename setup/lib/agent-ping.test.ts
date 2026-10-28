import { expect, it } from 'vitest';
import { classifyPingResult } from './agent-ping.js';
it.each([
  [0, 'A synthetic response', '', 'ok'],
  [0, '   ', '', 'no_reply'],
  [3, '', '', 'no_reply'],
  [2, '', 'Socket unavailable', 'socket_error'],
  [0, 'Invalid API key', '', 'auth_error'],
  [1, '', 'Authentication_error', 'auth_error'],
  [0, 'Invalid bearer token', '', 'auth_error'],
] as const)('classifies exit %i with a safe fixture', (code, output, errors, expected) => {
  expect(classifyPingResult(code, output, errors)).toBe(expected);
});
