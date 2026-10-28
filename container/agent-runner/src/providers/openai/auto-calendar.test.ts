import { describe, expect, it } from 'bun:test';

import type { RecallBridge } from './auto-recall.js';
import {
  buildCalendarAgendaBlock,
  calendarAgendaInsertIndex,
  calendarAgendaWindow,
  compactEventTime,
  fetchCalendarAgenda,
  formatAgendaLine,
  formatLocalDate,
  historyHasCalendarAgenda,
} from './auto-calendar.js';
import type { ChatMessage } from './types.js';

describe('auto calendar', () => {
  it('builds a 14-day local window from today', () => {
    const now = new Date(2026, 6, 23, 15, 30, 0); // Jul 23 2026 local
    const window = calendarAgendaWindow(now, 14);
    expect(window.from).toBe('2026-07-23');
    expect(window.to).toBe('2026-08-06');
    expect(window.fromIso).toBe('2026-07-23T00:00:00');
    expect(window.toIso).toBe('2026-08-06T23:59:59');
  });

  it('compacts EventKit display dates and ISO times', () => {
    expect(compactEventTime('Thursday, 23 July 2026 at 9:00:00 am')).toEqual({
      date: '2026-07-23',
      time: '09:00',
      allDayHint: false,
    });
    expect(compactEventTime('2026-07-24T14:30:00')).toEqual({
      date: '2026-07-24',
      time: '14:30',
      allDayHint: false,
    });
    expect(compactEventTime('2026-07-24')).toEqual({
      date: '2026-07-24',
      time: null,
      allDayHint: true,
    });
  });

  it('formats concise agenda lines with uid', () => {
    expect(
      formatAgendaLine({
        summary: 'Team standup',
        startDate: '2026-07-23T09:00:00',
        endDate: '2026-07-23T10:00:00',
        calendar: 'Home',
        uid: 'EK-abc',
      }),
    ).toBe('2026-07-23 09:00–10:00 | Team standup | id:EK-abc');

    expect(
      formatAgendaLine({
        summary: 'Holiday',
        startDate: '2026-07-24',
        endDate: '2026-07-24',
        calendar: 'Work',
        uid: 'EK-xyz',
        allDay: true,
      }),
    ).toBe('2026-07-24 all-day | Holiday | id:EK-xyz');
  });

  it('builds a calendar-agenda block including empty sentinel and calendar attr', () => {
    expect(buildCalendarAgendaBlock([], '2026-07-23', '2026-08-06', 14, undefined, 'Household')).toBe(
      '<calendar-agenda days="14" calendar="Household" from="2026-07-23" to="2026-08-06">\n(no events)\n</calendar-agenda>',
    );

    const block = buildCalendarAgendaBlock(
      [
        {
          summary: 'Standup',
          startDate: '2026-07-23T09:00:00',
          endDate: '2026-07-23T09:30:00',
          calendar: 'Household',
          uid: 'u1',
        },
      ],
      '2026-07-23',
      '2026-08-06',
      14,
      undefined,
      'Household',
    );
    expect(block).toContain('<calendar-agenda days="14" calendar="Household" from="2026-07-23" to="2026-08-06">');
    expect(block).toContain('id:u1');
    expect(block).toContain('</calendar-agenda>');
  });

  it('formats all-day from explicit allDay flag even when times look like midnight', () => {
    expect(
      formatAgendaLine({
        summary: 'Holiday',
        startDate: 'Thursday, 24 July 2026 at 12:00:00 am',
        endDate: 'Friday, 25 July 2026 at 12:00:00 am',
        calendar: 'Work',
        uid: 'EK-xyz',
        allDay: true,
      }),
    ).toBe('2026-07-24–2026-07-25 all-day | Holiday | id:EK-xyz');
  });

  it('detects calendar agenda in history and finds insert index', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '<conversation_summary>\nold\n</conversation_summary>' },
      { role: 'user', content: 'hello' },
    ];
    expect(historyHasCalendarAgenda(history)).toBe(false);
    expect(calendarAgendaInsertIndex(history)).toBe(1);

    history.splice(1, 0, {
      role: 'user',
      content: '<calendar-agenda days="14" calendar="Household" from="2026-07-23" to="2026-08-06">\nx\n</calendar-agenda>',
    });
    expect(historyHasCalendarAgenda(history)).toBe(true);
  });

  it('fetches agenda via list_calendar_events on the default calendar', async () => {
    const missing: RecallBridge = { has: () => false, call: async () => '' };
    expect(await fetchCalendarAgenda(missing)).toEqual({ available: false, reason: 'missing-tool' });

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const bridge: RecallBridge = {
      has: (name) => name === 'list_calendar_events',
      call: async (name, args) => {
        calls.push({ name, args });
        return JSON.stringify([
          {
            summary: 'Sync',
            startDate: '2026-07-23T11:00:00',
            endDate: '2026-07-23T12:00:00',
            calendar: 'Household',
            uid: 'uid-1',
          },
        ]);
      },
    };

    const now = new Date(2026, 6, 23, 8, 0, 0);
    const result = await fetchCalendarAgenda(bridge, { now, days: 14, defaultCalendar: 'Household' });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.events).toHaveLength(1);
      expect(result.from).toBe(formatLocalDate(now));
      expect(result.calendar).toBe('Household');
    }
    expect(calls[0]?.name).toBe('list_calendar_events');
    expect(calls[0]?.args.calendar).toBeUndefined();
    expect(calls[0]?.args.from_date).toBe('2026-07-23T00:00:00');
  });

  it('returns empty available agenda when default calendar is unset (fail closed)', async () => {
    const bridge: RecallBridge = {
      has: () => true,
      call: async () => {
        throw new Error('should not call');
      },
    };
    const result = await fetchCalendarAgenda(bridge, {
      now: new Date(2026, 6, 23),
      defaultCalendar: null,
    });
    expect(result).toEqual({
      available: true,
      events: [],
      from: '2026-07-23',
      to: '2026-08-06',
      calendar: '',
    });
  });

  it('treats empty event lists as available with zero events', async () => {
    const bridge: RecallBridge = {
      has: () => true,
      call: async () => '[]',
    };
    const result = await fetchCalendarAgenda(bridge, {
      now: new Date(2026, 6, 23),
      defaultCalendar: 'Household',
    });
    expect(result).toEqual({
      available: true,
      events: [],
      from: '2026-07-23',
      to: '2026-08-06',
      calendar: 'Household',
    });
  });
});
