/**
 * Unit tests for default-scope guards (no EventKit/TCC required).
 */
import { describe, expect, it } from 'vitest';

import { assertEventInDefaultCalendar, assertReminderInDefaultList, requireDefault } from './shared/defaults.js';

describe('apple default-scope guards', () => {
  it('requireDefault returns trimmed name and rejects empty', () => {
    expect(requireDefault('  Household  ', 'calendar')).toBe('Household');
    expect(() => requireDefault(null, 'calendar')).toThrow(/defaultCalendar/);
    expect(() => requireDefault('  ', 'reminders')).toThrow(/defaultList/);
  });

  it('assertReminderInDefaultList accepts matching list and rejects others/empty', () => {
    expect(() => assertReminderInDefaultList({ list: 'Household' }, 'Household')).not.toThrow();
    expect(() => assertReminderInDefaultList({ list: 'Other' }, 'Household')).toThrow(/not in configured default list/);
    expect(() => assertReminderInDefaultList({ list: '' }, 'Household')).toThrow(/not in configured default list/);
    expect(() => assertReminderInDefaultList({}, 'Household')).toThrow(/not in configured default list/);
  });

  it('assertEventInDefaultCalendar accepts matching calendar and rejects others/empty', () => {
    expect(() => assertEventInDefaultCalendar({ calendar: 'Household' }, 'Household')).not.toThrow();
    expect(() => assertEventInDefaultCalendar({ calendar: 'Home' }, 'Household')).toThrow(
      /not in configured default calendar/,
    );
    expect(() => assertEventInDefaultCalendar({ calendar: null }, 'Household')).toThrow(
      /not in configured default calendar/,
    );
    expect(() => assertEventInDefaultCalendar({}, 'Household')).toThrow(/not in configured default calendar/);
  });
});
