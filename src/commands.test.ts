import fs from 'fs';
import { describe, expect, it } from 'vitest';

import { TELEGRAM_BOT_COMMANDS } from './channels/telegram-bot-commands.js';
import { renderCommandHelp, renderCommandNames, SLASH_COMMANDS } from './commands.js';
import { MEMORY_COMMANDS } from './memory/commands.js';

describe('SLASH_COMMANDS', () => {
  it('lists every command with a leading slash and no duplicates', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names.every((n) => n.startsWith('/'))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes /help, so the gate can never silently drop it again', () => {
    const help = SLASH_COMMANDS.find((c) => c.name === '/help');
    expect(help).toBeDefined();
    expect(help?.ownerOnly).toBe(false);
  });

  it('exposes the owner-only scheduled task list', () => {
    const tasks = SLASH_COMMANDS.find((c) => c.name === '/tasks');
    expect(tasks).toBeDefined();
    expect(tasks?.ownerOnly).toBe(true);
  });

  it('lists the memory reads as open to every participant', () => {
    for (const name of ['/read', '/list', '/recall']) {
      const spec = SLASH_COMMANDS.find((c) => c.name === name);
      expect(spec, `${name} is missing from SLASH_COMMANDS`).toBeDefined();
      expect(spec?.ownerOnly).toBe(false);
    }
  });

  /**
   * Correcting memory is open too. This is a shared agent — the memory is the household's, not one
   * account's — and the person best placed to remove a wrong sentence is whoever noticed it.
   */
  it('leaves the memory corrections open as well', () => {
    for (const name of ['/forget', '/undo']) {
      const spec = SLASH_COMMANDS.find((c) => c.name === name);
      expect(spec, `${name} is missing from SLASH_COMMANDS`).toBeDefined();
      expect(spec?.ownerOnly).toBe(false);
    }
  });

  /**
   * A command the container handles but the host has never heard of gets
   * "Command not recognized" from the gate and never reaches the runner — a
   * silent break with nothing failing. The container module cannot be imported
   * here (it would drag in the session client and bun-only APIs), so the set is
   * read as text.
   */
  it('knows every command the container runner handles', () => {
    const source = fs.readFileSync(
      new URL('../container/agent-runner/src/session-commands.ts', import.meta.url),
      'utf8',
    );
    const block = /export const RUNNER_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '';
    const runnerCommands = [...block.matchAll(/'(\/[a-z0-9_-]+)'/g)].map((m) => m[1]);

    expect(runnerCommands.length).toBeGreaterThan(0);
    const known = new Set(SLASH_COMMANDS.map((c) => c.name));
    expect(runnerCommands.filter((name) => !known.has(name))).toEqual([]);

    // Nothing may be claimed by both. The host answers a memory command itself and returns before
    // the message is queued, so a command left in both sets does not fail — it answers twice, once
    // from the host and once from a container that no longer has a knowledge base to read.
    expect(runnerCommands.filter((name) => MEMORY_COMMANDS.has(name))).toEqual([]);
  });

  it('declares every memory command it hands to the host handler', () => {
    // A command in MEMORY_COMMANDS but not in SLASH_COMMANDS is refused by the gate as
    // unrecognized and never reaches the handler that exists for it.
    const known = new Set(SLASH_COMMANDS.map((c) => c.name));
    expect([...MEMORY_COMMANDS].filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('renderCommandHelp', () => {
  it('hides owner commands from non-owners', () => {
    const text = renderCommandHelp(false);
    expect(text).toContain('/clear');
    expect(text).not.toContain('/restart');
  });

  it('shows owner commands to owners', () => {
    const text = renderCommandHelp(true);
    expect(text).toContain('/restart');
    expect(text).toContain('/health');
  });

  it('aligns descriptions into a column', () => {
    const lines = renderCommandHelp(true).split('\n').slice(1);
    const starts = lines.map((l) => {
      const m = /^(\/\S+)( +)\S/.exec(l);
      expect(m).not.toBeNull();
      return m![1].length + m![2].length;
    });
    expect(new Set(starts).size).toBe(1);
  });
});

describe('renderCommandNames', () => {
  it('is a single line of names for the CLI banner', () => {
    const line = renderCommandNames(true);
    expect(line).not.toContain('\n');
    expect(line.split(' ')).toHaveLength(SLASH_COMMANDS.length);
  });
});

describe('TELEGRAM_BOT_COMMANDS', () => {
  it('mirrors the canonical list without the leading slash', () => {
    expect(TELEGRAM_BOT_COMMANDS.map((c) => `/${c.command}`)).toEqual(SLASH_COMMANDS.map((c) => c.name));
  });

  it('labels owner-only entries, since Telegram shows one menu to everyone', () => {
    const restart = TELEGRAM_BOT_COMMANDS.find((c) => c.command === 'restart');
    const clear = TELEGRAM_BOT_COMMANDS.find((c) => c.command === 'clear');
    expect(restart?.description).toMatch(/\(owner\)$/);
    expect(clear?.description).not.toMatch(/\(owner\)$/);
  });

  it('stays inside the Bot API description limit', () => {
    for (const c of TELEGRAM_BOT_COMMANDS) {
      expect(c.description.length).toBeLessThanOrEqual(256);
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
