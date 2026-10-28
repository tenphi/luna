import { describe, expect, it } from 'vitest';

import { assertCalendarRange, calendarInstantToUtcIso, parseCalendarTimezoneParam } from './calendar-dates.js';
import { dateToISO } from './applescript.js';

describe('parseCalendarTimezoneParam', () => {
  it('defaults both sides to fallback when absent', () => {
    expect(parseCalendarTimezoneParam(undefined, 'Europe/Berlin')).toEqual({
      start: 'Europe/Berlin',
      end: 'Europe/Berlin',
      pin: 'Europe/Berlin',
    });
    expect(parseCalendarTimezoneParam('', 'Europe/Berlin')).toEqual({
      start: 'Europe/Berlin',
      end: 'Europe/Berlin',
      pin: 'Europe/Berlin',
    });
  });

  it('uses a single IANA id for start, end, and pin', () => {
    expect(parseCalendarTimezoneParam('America/New_York', 'UTC')).toEqual({
      start: 'America/New_York',
      end: 'America/New_York',
      pin: 'America/New_York',
    });
  });

  it('parses comma-separated start,end and pins start', () => {
    expect(parseCalendarTimezoneParam('Asia/Tokyo,America/Los_Angeles', 'UTC')).toEqual({
      start: 'Asia/Tokyo',
      end: 'America/Los_Angeles',
      pin: 'Asia/Tokyo',
    });
  });

  it('rejects invalid IANA and malformed pairs', () => {
    expect(() => parseCalendarTimezoneParam('NotAZone', 'UTC')).toThrow(/Invalid IANA/);
    expect(() => parseCalendarTimezoneParam('Asia/Tokyo,America/Los_Angeles,UTC', 'UTC')).toThrow(/Invalid timezone/);
    expect(() => parseCalendarTimezoneParam('Asia/Tokyo,', 'UTC')).toThrow(/Invalid timezone/);
    expect(() => parseCalendarTimezoneParam(',America/New_York', 'UTC')).toThrow(/Invalid timezone/);
  });
});

describe('calendarInstantToUtcIso', () => {
  it('preserves Z and numeric offsets as absolute instants', () => {
    expect(calendarInstantToUtcIso('2026-01-15T09:00:00Z', 'America/New_York')).toBe('2026-01-15T09:00:00Z');
    expect(calendarInstantToUtcIso('2026-01-15T09:00:00+02:00', 'America/New_York')).toBe('2026-01-15T07:00:00Z');
  });

  it('interprets naive ISO in the given zone', () => {
    expect(calendarInstantToUtcIso('2026-01-15T09:00', 'America/New_York')).toBe('2026-01-15T14:00:00Z');
    expect(calendarInstantToUtcIso('2026-06-15T09:00:00', 'Asia/Tokyo')).toBe('2026-06-15T00:00:00Z');
  });

  it('supports dual-zone flight duration via separate conversions', () => {
    // Departs 10:00 in Asia/Tokyo, arrives 06:00 in America/Los_Angeles the same calendar day (summer)
    const dep = calendarInstantToUtcIso('2031-07-16T10:00', 'Asia/Tokyo');
    const arr = calendarInstantToUtcIso('2031-07-16T06:00', 'America/Los_Angeles');
    expect(dep).toBe('2031-07-16T01:00:00Z');
    expect(arr).toBe('2031-07-16T13:00:00Z');
    expect(Date.parse(arr) - Date.parse(dep)).toBe(12 * 60 * 60 * 1000);
  });
});

describe('assertCalendarRange', () => {
  it('accepts end after start', () => {
    expect(() => assertCalendarRange('2031-07-16T01:00:00Z', '2031-07-16T13:00:00Z')).not.toThrow();
  });

  it('rejects end before or equal to start', () => {
    expect(() => assertCalendarRange('2031-07-16T13:00:00Z', '2031-07-16T01:00:00Z')).toThrow(
      /end must be after start/,
    );
    expect(() => assertCalendarRange('2031-07-16T01:00:00Z', '2031-07-16T01:00:00Z')).toThrow(
      /end must be after start/,
    );
  });
});

describe('all-day dateToISO stability', () => {
  it('keeps date-only naive wall-clock (no Zoned UTC shift)', () => {
    // Reminders/calendar all-day path still uses dateToISO — must not become UTC midnight.
    expect(dateToISO('2031-05-14')).toBe('2031-05-14T00:00:00');
    expect(dateToISO('2031-05-14T00:00:00')).toBe('2031-05-14T00:00:00');
  });
});
