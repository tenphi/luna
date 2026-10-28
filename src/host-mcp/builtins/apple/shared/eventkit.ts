/**
 * TypeScript wrapper around the vendored EventKit Swift helper (`calendar-helper`).
 * Handles Calendar reads and uid-based writes (create/update/delete), including
 * url / alerts / recurrence.
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-calendar-mcp` 1.0.0),
 * vendored in-tree by Luna.
 */
import { execFile } from 'node:child_process';

import { TIMEZONE } from '../../../../config.js';
import { dateToISO } from './applescript.js';
import { assertCalendarRange, calendarInstantToUtcIso, parseCalendarTimezoneParam } from './calendar-dates.js';
import { resolveCalendarHelper } from './paths.js';

export interface CalendarEvent {
  summary: string;
  startDate: string;
  endDate: string;
  location: string | null;
  calendar?: string;
  uid: string;
  description?: string | null;
  url?: string | null;
  allDay?: boolean;
  /** Pinned EventKit timezone (IANA), when set. */
  timeZone?: string | null;
  alerts?: Array<{ offsetMinutes: number }>;
  recurrence?: RecurrenceRule | null;
}

export interface RecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  daysOfWeek?: string[] | null;
  endDate?: string | null;
  occurrenceCount?: number | null;
}

export interface CreateEventOptions {
  location?: string;
  description?: string;
  allDay?: boolean;
  url?: string;
  /** Optional IANA zone, or `start,end` comma pair for flights. */
  timezone?: string;
  alerts?: Array<{ offsetMinutes: number }>;
  recurrence?: RecurrenceRule;
}

export interface UpdateEventOptions {
  summary?: string;
  startDate?: string;
  endDate?: string;
  location?: string | null;
  description?: string | null;
  allDay?: boolean;
  url?: string | null;
  /** Optional IANA zone, or `start,end` comma pair for flights. */
  timezone?: string;
  /** Existing event pin when `timezone` is omitted (from get/list). */
  fallbackTimezone?: string | null;
  /** Existing display start (install TZ) — fills in when only end_date is updated. */
  existingStartDate?: string;
  /** Existing display end (install TZ) — fills in when only start_date is updated. */
  existingEndDate?: string;
  alerts?: Array<{ offsetMinutes: number }> | null;
  recurrence?: RecurrenceRule | null;
}

export interface DeleteEventResult {
  deleted: boolean;
  uid: string;
  summary: string;
}

/** Shared runner for calendar-helper (also used by reminders-eventkit). */
export function runCalendarHelper(args: string[]): Promise<string> {
  const binary = resolveCalendarHelper();
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        try {
          const parsed = JSON.parse(stdout) as { error?: string };
          if (parsed.error) {
            reject(new Error(parsed.error));
            return;
          }
        } catch {
          /* not JSON — fall through */
        }
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export function withDisplayTimezone(args: string[]): string[] {
  return [...args, '--display-timezone', TIMEZONE];
}

function resolveTimedBounds(
  startDate: string,
  endDate: string,
  timezone: string | undefined,
  fallbackTimezone?: string | null,
): { from: string; to: string; pin: string } {
  const fallback = fallbackTimezone && fallbackTimezone.trim() ? fallbackTimezone.trim() : TIMEZONE;
  const zones = parseCalendarTimezoneParam(timezone, fallback);
  const from = calendarInstantToUtcIso(startDate, zones.start);
  const to = calendarInstantToUtcIso(endDate, zones.end);
  assertCalendarRange(from, to);
  return { from, to, pin: zones.pin };
}

export async function listEvents(
  calendarName: string,
  fromDate: string,
  toDate: string,
): Promise<Omit<CalendarEvent, 'calendar'>[]> {
  const from = calendarInstantToUtcIso(fromDate, TIMEZONE);
  const to = calendarInstantToUtcIso(toDate, TIMEZONE);
  const events = JSON.parse(
    await runCalendarHelper(
      withDisplayTimezone(['list-events', '--from', from, '--to', to, '--calendar', calendarName]),
    ),
  ) as CalendarEvent[];
  return events.map(({ calendar, ...rest }) => rest);
}

export async function getEvent(uid: string): Promise<CalendarEvent> {
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(['get-event', '--uid', uid]))) as CalendarEvent;
}

export async function searchEvents(query: string, calendarName: string): Promise<CalendarEvent[]> {
  return JSON.parse(
    await runCalendarHelper(withDisplayTimezone(['search-events', '--query', query, '--calendar', calendarName])),
  ) as CalendarEvent[];
}

export async function createEvent(
  calendarName: string,
  summary: string,
  startDate: string,
  endDate: string,
  options?: CreateEventOptions,
): Promise<CalendarEvent> {
  const allDay = options?.allDay === true;
  if (allDay && options?.timezone) {
    throw new Error('timezone cannot be used with all-day events');
  }

  let from: string;
  let to: string;
  let pin: string | undefined;
  if (allDay) {
    from = dateToISO(startDate);
    to = dateToISO(endDate);
  } else {
    const bounds = resolveTimedBounds(startDate, endDate, options?.timezone);
    from = bounds.from;
    to = bounds.to;
    pin = bounds.pin;
  }

  const args = withDisplayTimezone([
    'create-event',
    '--calendar',
    calendarName,
    '--title',
    summary,
    '--from',
    from,
    '--to',
    to,
  ]);
  if (pin) args.push('--timezone', pin);
  if (options?.location) args.push('--location', options.location);
  if (options?.description) args.push('--notes', options.description);
  if (options?.allDay !== undefined) args.push('--all-day', options.allDay ? 'true' : 'false');
  if (options?.url) args.push('--url', options.url);
  if (options?.alerts) args.push('--alerts', JSON.stringify(options.alerts));
  if (options?.recurrence) args.push('--recurrence', JSON.stringify(options.recurrence));
  return JSON.parse(await runCalendarHelper(args)) as CalendarEvent;
}

export async function updateEvent(uid: string, updates: UpdateEventOptions): Promise<CalendarEvent> {
  if (updates.allDay === true && updates.timezone) {
    throw new Error('timezone cannot be used with all-day events');
  }

  const args = withDisplayTimezone(['update-event', '--uid', uid]);
  if (updates.summary !== undefined) args.push('--title', updates.summary);

  const touchingTimes =
    updates.startDate !== undefined || updates.endDate !== undefined || updates.timezone !== undefined;

  if (touchingTimes && updates.allDay !== true) {
    if (updates.startDate !== undefined || updates.endDate !== undefined) {
      const fallback =
        updates.fallbackTimezone && updates.fallbackTimezone.trim() ? updates.fallbackTimezone.trim() : TIMEZONE;
      const zones = parseCalendarTimezoneParam(updates.timezone, fallback);
      const startRaw = updates.startDate ?? updates.existingStartDate;
      const endRaw = updates.endDate ?? updates.existingEndDate;
      if (!startRaw || !endRaw) {
        throw new Error('Updating event times requires start and end (pass both, or load the existing event)');
      }
      // Provided sides use start/end zones; unchanged side was displayed in install TIMEZONE.
      const from = calendarInstantToUtcIso(startRaw, updates.startDate !== undefined ? zones.start : TIMEZONE);
      const to = calendarInstantToUtcIso(endRaw, updates.endDate !== undefined ? zones.end : TIMEZONE);
      assertCalendarRange(from, to);
      args.push('--from', from, '--to', to, '--timezone', zones.pin);
    } else if (updates.timezone !== undefined) {
      const zones = parseCalendarTimezoneParam(updates.timezone, TIMEZONE);
      args.push('--timezone', zones.pin);
    }
  } else {
    if (updates.startDate !== undefined) args.push('--from', dateToISO(updates.startDate));
    if (updates.endDate !== undefined) args.push('--to', dateToISO(updates.endDate));
  }

  if (updates.location === null) {
    args.push('--clear-location');
  } else if (updates.location !== undefined) {
    args.push('--location', updates.location);
  }
  if (updates.description === null) {
    args.push('--clear-notes');
  } else if (updates.description !== undefined) {
    args.push('--notes', updates.description);
  }
  if (updates.allDay !== undefined) args.push('--all-day', updates.allDay ? 'true' : 'false');
  if (updates.url === null) {
    args.push('--clear-url');
  } else if (updates.url !== undefined) {
    args.push('--url', updates.url);
  }
  if (updates.alerts === null) {
    args.push('--clear-alerts');
  } else if (updates.alerts !== undefined) {
    args.push('--alerts', JSON.stringify(updates.alerts));
  }
  if (updates.recurrence === null) {
    args.push('--clear-recurrence');
  } else if (updates.recurrence !== undefined) {
    args.push('--recurrence', JSON.stringify(updates.recurrence));
  }
  return JSON.parse(await runCalendarHelper(args)) as CalendarEvent;
}

export async function deleteEvent(uid: string): Promise<DeleteEventResult> {
  return JSON.parse(await runCalendarHelper(['delete-event', '--uid', uid])) as DeleteEventResult;
}
