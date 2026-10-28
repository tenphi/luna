/**
 * Calendar-only date/timezone helpers. Keep {@link dateToISO} naive for Reminders;
 * timed calendar events go through zoned UTC ISO for EventKit.
 */
import { isValidTimezone, parseZonedToUtc } from '../../../../timezone.js';
import { dateToISO } from './applescript.js';

export interface CalendarTimezoneParts {
  /** IANA zone for interpreting naive start wall-clock. */
  start: string;
  /** IANA zone for interpreting naive end wall-clock. */
  end: string;
  /** Zone pinned on EKEvent.timeZone (always the start zone). */
  pin: string;
}

/**
 * Parse optional `timezone` tool arg: one IANA id, or `start,end` comma pair.
 */
export function parseCalendarTimezoneParam(raw: string | undefined | null, fallback: string): CalendarTimezoneParts {
  if (raw == null || raw.trim() === '') {
    return { start: fallback, end: fallback, pin: fallback };
  }
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.length > 2 || parts.some((p) => !p)) {
    throw new Error(
      `Invalid timezone: "${raw}". Use an IANA id (e.g. America/New_York) or "Start/Zone,End/Zone" for flights.`,
    );
  }
  for (const p of parts) {
    if (!isValidTimezone(p)) {
      throw new Error(`Invalid IANA timezone: "${p}"`);
    }
  }
  if (parts.length === 1) {
    const z = parts[0]!;
    return { start: z, end: z, pin: z };
  }
  return { start: parts[0]!, end: parts[1]!, pin: parts[0]! };
}

function toUtcIsoSeconds(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid date');
  }
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Convert a flexible calendar date/time string to absolute UTC ISO (`…Z`).
 * Offset/`Z` strings are absolute; naive/NL strings are wall-clock in `tz`.
 */
export function calendarInstantToUtcIso(input: string, tz: string): string {
  const trimmed = input.trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return toUtcIsoSeconds(parseZonedToUtc(trimmed, tz));
  }
  const naive = dateToISO(input);
  return toUtcIsoSeconds(parseZonedToUtc(naive, tz));
}

/** Assert absolute end is strictly after start; used after zoned conversion. */
export function assertCalendarRange(fromUtcIso: string, toUtcIso: string): void {
  const from = Date.parse(fromUtcIso);
  const to = Date.parse(toUtcIso);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new Error('Invalid start or end date');
  }
  if (to <= from) {
    throw new Error(
      `Event end must be after start (got ${fromUtcIso} → ${toUtcIso}). For flights, check arrival date and timezone.`,
    );
  }
}
