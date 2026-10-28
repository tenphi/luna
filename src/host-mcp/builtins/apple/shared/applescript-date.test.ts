import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { dateToISO, parseDateInput } from './applescript.js';

describe('dateToISO', () => {
  it('preserves ISO wall-clock times (agenda window end must not collapse to midnight)', () => {
    expect(dateToISO('2026-07-23T00:00:00')).toBe('2026-07-23T00:00:00');
    expect(dateToISO('2026-08-06T23:59:59')).toBe('2026-08-06T23:59:00');
    expect(dateToISO('2026-08-06 14:30:00')).toBe('2026-08-06T14:30:00');
  });

  it('still parses natural-language dates with at-time', () => {
    expect(dateToISO('15 March 2025 at 2:00 PM')).toBe('2025-03-15T14:00:00');
    expect(dateToISO('2026-03-09')).toBe('2026-03-09T00:00:00');
  });

  it('reads a clock without "at", and an hour without minutes', () => {
    expect(dateToISO('15 March 2025 2:00 PM')).toBe('2025-03-15T14:00:00');
    expect(dateToISO('15 March 2025 at 7pm')).toBe('2025-03-15T19:00:00');
    expect(dateToISO('March 15, 2025 12am')).toBe('2025-03-15T00:00:00');
    expect(dateToISO('Monday, 9 March 2026 at 12:30 PM')).toBe('2026-03-09T12:30:00');
  });

  it('rejects a date it cannot read rather than guessing', () => {
    expect(() => dateToISO('yesterday')).toThrow(/Invalid date/);
  });
});

describe('parseDateInput', () => {
  it('reports whether the input named a clock — an all-day due depends on it', () => {
    expect(parseDateInput('13 August 2026')).toEqual({
      iso: '2026-08-13T00:00:00',
      date: '2026-08-13',
      hasTime: false,
    });
    expect(parseDateInput('2026-08-13')).toMatchObject({ date: '2026-08-13', hasTime: false });
    expect(parseDateInput('14 May 2031 at 6:40 PM')).toMatchObject({ hasTime: true });
    expect(parseDateInput('2026-08-13T00:00:00')).toMatchObject({ hasTime: true });
  });

  it('keeps a bare ISO date on its own day west of Greenwich', () => {
    // `new Date('2026-08-13')` is UTC midnight, which is 12 August in New York — a "done
    // yesterday" window would have been built around the wrong day.
    const script =
      "import('./src/host-mcp/builtins/apple/shared/applescript.ts').then((m) => console.log(m.dateToISO('2026-08-13')))";
    const out = execFileSync('node', ['--import', 'tsx', '-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('2026-08-13T00:00:00');
  });
});
