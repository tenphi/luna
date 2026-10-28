/**
 * AppleScript execution + escaping helpers shared by the in-process Apple MCP
 * servers (Reminders, Notes, Contacts, Calendar writes, Messages send).
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-*-mcp` 1.0.0),
 * vendored in-tree by Luna. The AppleScript templates live in the per-app
 * server modules; this file holds the primitives they share.
 */
import { execFile } from 'node:child_process';

/** Delimiters used to serialize AppleScript record/field lists back to JS. */
export const FIELD_DELIM = '|||';
export const RECORD_DELIM = '<<<>>>';

/**
 * Escape a string for safe embedding inside an AppleScript double-quoted
 * literal. Handles backslashes, double quotes, and newlines.
 */
export function sanitize(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n');
}

/** Execute an AppleScript string via osascript and return trimmed stdout. */
export function runAppleScript(script: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { maxBuffer: 10 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new Error('AppleScript timed out — the query took too long'));
          return;
        }
        reject(new Error(`AppleScript error: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

interface ParsedDate {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  /** False when the input named a day and no clock — the caller decides what that means. */
  hasTime: boolean;
}

/** "at 6:40 PM", "6:40 pm", "at 7pm" — a meridiem clock, with or without minutes. */
const MERIDIEM_TIME = /(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)\b/i;
/** 24-hour clock, which needs the "at" to not read a date's own digits as a time. */
const CLOCK_TIME = /\bat\s+(\d{1,2}):(\d{2})(?::\d{2})?/i;

/**
 * Parse a flexible date string into components, handling formats such as
 * "March 9, 2026", "9 March 2026", "Monday, 9 March 2026", "2026-03-09",
 * "2026-03-09T14:30:00", "March 15, 2025 at 2:00 PM" and "March 15, 2025 7pm".
 */
function parseFlexibleDate(input: string): ParsedDate {
  // Strip day names like "Monday, "
  const cleaned = input.replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '');

  // ISO / ISO-like: 2026-07-23T23:59:59 or 2026-07-23 23:59
  const isoTime = cleaned.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?/);
  if (isoTime) {
    return {
      year: parseInt(isoTime[1]!.slice(0, 4), 10),
      month: parseInt(isoTime[1]!.slice(5, 7), 10),
      day: parseInt(isoTime[1]!.slice(8, 10), 10),
      hours: parseInt(isoTime[2]!, 10),
      minutes: parseInt(isoTime[3]!, 10),
      hasTime: true,
    };
  }

  // A bare ISO date, read by hand: `new Date('2026-03-09')` is UTC midnight, so any
  // host west of Greenwich would report the day before.
  const isoDate = cleaned.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    return {
      year: parseInt(isoDate[1]!, 10),
      month: parseInt(isoDate[2]!, 10),
      day: parseInt(isoDate[3]!, 10),
      hours: 0,
      minutes: 0,
      hasTime: false,
    };
  }

  let hours = 0;
  let minutes = 0;
  let hasTime = false;
  let dateOnly = cleaned;

  const meridiem = cleaned.match(MERIDIEM_TIME);
  const clock = meridiem ? null : cleaned.match(CLOCK_TIME);
  if (meridiem) {
    hours = parseInt(meridiem[1]!, 10);
    minutes = meridiem[2] ? parseInt(meridiem[2], 10) : 0;
    if (meridiem[3]!.toLowerCase() === 'pm' && hours < 12) hours += 12;
    if (meridiem[3]!.toLowerCase() === 'am' && hours === 12) hours = 0;
    hasTime = true;
    dateOnly = cleaned.replace(MERIDIEM_TIME, '');
  } else if (clock) {
    hours = parseInt(clock[1]!, 10);
    minutes = parseInt(clock[2]!, 10);
    hasTime = true;
    dateOnly = cleaned.replace(CLOCK_TIME, '');
  }

  const parsed = new Date(dateOnly.replace(/[,\s]+$/, '').trim());
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: "${input}"`);
  }
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
    hours,
    minutes,
    hasTime,
  };
}

export interface DateInput {
  /** Naive ISO 8601 for the Swift helper, read there in the install timezone. */
  iso: string;
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** False when the input named a day and no clock. */
  hasTime: boolean;
}

/** Normalize a flexible date string, keeping whether it carried a clock. */
export function parseDateInput(input: string): DateInput {
  const { year, month, day, hours, minutes, hasTime } = parseFlexibleDate(input);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const min = String(minutes).padStart(2, '0');
  const date = `${year}-${mm}-${dd}`;
  return { iso: `${date}T${hh}:${min}:00`, date, hasTime };
}

/** Normalize a flexible date string into ISO 8601 (for the Swift helper). */
export function dateToISO(input: string): string {
  return parseDateInput(input).iso;
}
