import { describe, expect, it } from 'vitest';

import { OPEN_COMMANDS, OWNER_COMMANDS } from '../command-gate.js';
import { TELEGRAM_BOT_COMMANDS } from './telegram-bot-commands.js';

/**
 * The menu and the gate are edited in different files, so they drift silently:
 * `/topics` shipped gated but unlisted. Pin them together in both directions.
 */
describe('TELEGRAM_BOT_COMMANDS', () => {
  const menu = new Set(TELEGRAM_BOT_COMMANDS.map((c) => `/${c.command}`));
  const gated = new Set([...OPEN_COMMANDS, ...OWNER_COMMANDS]);

  it('lists every gated command', () => {
    expect([...gated].filter((c) => !menu.has(c))).toEqual([]);
  });

  it('lists nothing the gate would reject as unrecognized', () => {
    expect([...menu].filter((c) => !gated.has(c))).toEqual([]);
  });

  it('marks owner-only commands in their descriptions', () => {
    for (const entry of TELEGRAM_BOT_COMMANDS) {
      if (!OWNER_COMMANDS.has(`/${entry.command}`)) continue;
      expect(entry.description).toContain('(owner)');
    }
  });
});
