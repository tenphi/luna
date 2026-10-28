import { describe, expect, it } from 'bun:test';

import type { RecallBridge } from './auto-recall.js';
import {
  buildRemindersAgendaBlock,
  fetchRemindersAgenda,
  filterRemindersForAgenda,
  formatReminderLine,
  historyHasRemindersAgenda,
  isReminderInAgendaWindow,
  remindersAgendaInsertIndex,
} from './auto-reminders.js';
import type { ChatMessage } from './types.js';

describe('auto reminders', () => {
  it('formats reminder lines with optional due and id', () => {
    expect(
      formatReminderLine({
        name: 'Buy milk',
        id: 'r1',
        dueDate: '2026-07-24',
        list: 'Household',
      }),
    ).toBe('Buy milk | due:2026-07-24 | Household | id:r1');

    expect(formatReminderLine({ name: 'Call mom', id: 'r2' }, 'Household')).toBe(
      'Call mom | Household | id:r2',
    );
  });

  it('builds a reminders-agenda block including empty sentinel', () => {
    expect(buildRemindersAgendaBlock([], 'Household')).toBe(
      '<reminders-agenda list="Household">\n(no reminders)\n</reminders-agenda>',
    );
    expect(buildRemindersAgendaBlock([], '')).toBe(
      '<reminders-agenda>\n(no reminders)\n</reminders-agenda>',
    );

    const block = buildRemindersAgendaBlock(
      [
        { name: 'Buy milk', id: 'r1' },
        { name: 'Water plants', id: 'r2', dueDate: 'Friday' },
      ],
      'Household',
    );
    expect(block).toContain('<reminders-agenda list="Household">');
    expect(block).toContain('Buy milk | id:r1');
    expect(block).toContain('Water plants | due:Friday | id:r2');
    expect(block).not.toContain('Buy milk | Household');
    expect(block).toContain('</reminders-agenda>');
  });

  it('keeps undated / near-term / overdue and drops far-dated reminders', () => {
    const now = new Date(2026, 6, 23); // Thu 23 Jul 2026 local
    expect(isReminderInAgendaWindow({ name: 'No due' }, now)).toBe(true);
    expect(isReminderInAgendaWindow({ name: 'Soon', dueDate: '2026-07-30' }, now)).toBe(true);
    expect(isReminderInAgendaWindow({ name: 'Horizon', dueDate: '2026-08-06' }, now)).toBe(true);
    expect(isReminderInAgendaWindow({ name: 'Overdue', dueDate: '2026-07-01' }, now)).toBe(true);
    expect(
      isReminderInAgendaWindow(
        { name: 'Blackwater Bay docs', dueDate: 'Saturday, 29 August 2026 at 11:00:00 am' },
        now,
      ),
    ).toBe(false);
    expect(isReminderInAgendaWindow({ name: 'Far ISO', dueDate: '2026-08-07' }, now)).toBe(false);
    expect(isReminderInAgendaWindow({ name: 'Weird', dueDate: 'someday soon' }, now)).toBe(true);

    const filtered = filterRemindersForAgenda(
      [
        { name: 'Buy milk', id: 'a' },
        { name: 'Office', id: 'b', dueDate: '2026-07-29' },
        { name: 'Travel docs', id: 'c', dueDate: '2026-08-29' },
      ],
      now,
    );
    expect(filtered.map((r) => r.name)).toEqual(['Buy milk', 'Office']);
  });

  it('detects reminders agenda in history and finds insert index', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '<conversation_summary>\nold\n</conversation_summary>' },
      { role: 'user', content: 'hello' },
    ];
    expect(historyHasRemindersAgenda(history)).toBe(false);
    expect(remindersAgendaInsertIndex(history)).toBe(1);

    history.splice(1, 0, {
      role: 'user',
      content: '<reminders-agenda list="Household">\nx\n</reminders-agenda>',
    });
    expect(historyHasRemindersAgenda(history)).toBe(true);
  });

  it('fetches incomplete reminders from the default list', async () => {
    const missing: RecallBridge = { has: () => false, call: async () => '' };
    expect(await fetchRemindersAgenda(missing)).toEqual({ available: false, reason: 'missing-tool' });

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge: RecallBridge = {
      has: (name) => name === 'list_reminders',
      call: async (name, args) => {
        calls.push({ name, args });
        return JSON.stringify([
          { name: 'Open', id: 'a', completed: false },
          { name: 'Done', id: 'b', completed: true },
          { name: 'Far', id: 'c', completed: false, dueDate: '2026-12-01' },
          { name: 'Near', id: 'd', completed: false, dueDate: '2026-07-25' },
        ]);
      },
    };

    const result = await fetchRemindersAgenda(bridge, {
      defaultRemindersList: 'Household',
      now: new Date(2026, 6, 23),
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.list).toBe('Household');
      expect(result.reminders.map((r) => r.name)).toEqual(['Open', 'Near']);
    }
    expect(calls[0]?.name).toBe('list_reminders');
    expect(calls[0]?.args).toEqual({ include_completed: false });
  });

  it('reads the host list payload as well as a bare array', async () => {
    const bridge: RecallBridge = {
      has: (name) => name === 'list_reminders',
      call: async () =>
        JSON.stringify({
          list: 'Household',
          total: 2,
          returned: 2,
          truncated: false,
          reminders: [
            { name: 'Open', id: 'a', completed: false },
            { name: 'Done', id: 'b', completed: true },
          ],
        }),
    };

    const result = await fetchRemindersAgenda(bridge, {
      defaultRemindersList: 'Household',
      now: new Date(2026, 6, 23),
    });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.reminders.map((r) => r.name)).toEqual(['Open']);
    }
  });

  it('returns empty available agenda when default list is unset (fail closed)', async () => {
    const bridge: RecallBridge = {
      has: () => true,
      call: async () => {
        throw new Error('should not call');
      },
    };
    const result = await fetchRemindersAgenda(bridge, { defaultRemindersList: null });
    expect(result).toEqual({ available: true, reminders: [], list: '' });
  });
});
