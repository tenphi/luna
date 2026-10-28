import { expect, it } from 'bun:test';

import { formatLocalTime, isValidTimezone, parseZonedToUtc, resolveTimezone } from './timezone.js';

it.each(['UTC', 'Europe/Paris', 'Australia/Sydney'])('accepts the %s time zone', (zone) => {
  expect(isValidTimezone(zone)).toBe(true);
  expect(resolveTimezone(zone)).toBe(zone);
});
it.each(['', 'not-a-zone', 'XYZ+3'])('uses UTC for invalid zone %s', (zone) => {
  expect(isValidTimezone(zone)).toBe(false);
  expect(resolveTimezone(zone)).toBe('UTC');
});
it.each([
  ['2027-01-11T09:15:00', 'America/New_York', '2027-01-11T14:15:00.000Z'],
  ['2027-07-11T09:15:00', 'America/New_York', '2027-07-11T13:15:00.000Z'],
  ['2027-01-11T09:15:00', 'Asia/Tokyo', '2027-01-11T00:15:00.000Z'],
  ['2027-01-11T09:15:00+02:00', 'Asia/Tokyo', '2027-01-11T07:15:00.000Z'],
  ['2027-03-14T02:30:00', 'America/New_York', '2027-03-14T07:30:00.000Z'],
  ['2027-11-07T01:30:00', 'America/New_York', '2027-11-07T05:30:00.000Z'],
])('resolves %s in %s', (input, zone, utc) => {
  expect(parseZonedToUtc(input, zone).toISOString()).toBe(utc);
});
it('displays local time and preserves milliseconds during conversion', () => {
  expect(formatLocalTime('2027-01-11T14:15:00Z', 'America/New_York')).toContain('9:15');
  expect(parseZonedToUtc('2027-01-11T09:15:00.123', 'Asia/Tokyo').toISOString()).toBe('2027-01-11T00:15:00.123Z');
  expect(Number.isNaN(parseZonedToUtc('invalid', 'UTC').getTime())).toBe(true);
});
