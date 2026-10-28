import { describe, expect, it } from 'vitest';

import { parseSlashCommand } from './slash-command.js';

describe('parseSlashCommand', () => {
  it('parses plain commands', () => {
    expect(parseSlashCommand('/clear')).toBe('/clear');
    expect(parseSlashCommand('/usage')).toBe('/usage');
  });

  it('strips Telegram @bot suffix', () => {
    expect(parseSlashCommand('/context@luna_bot')).toBe('/context');
    expect(parseSlashCommand('/usage@MyBot')).toBe('/usage');
  });

  it('ignores args after the command token', () => {
    expect(parseSlashCommand('/compact force')).toBe('/compact');
  });

  it('returns null for non-commands', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('/')).toBeNull();
  });
});
