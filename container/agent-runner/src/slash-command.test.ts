import { describe, expect, it } from 'bun:test';

import { parseSlashCommand } from './slash-command.js';

describe('parseSlashCommand', () => {
  it('parses plain commands', () => {
    expect(parseSlashCommand('/files')).toBe('/files');
  });

  it('strips Telegram @bot suffix', () => {
    expect(parseSlashCommand('/clear@luna_bot')).toBe('/clear');
  });
});
