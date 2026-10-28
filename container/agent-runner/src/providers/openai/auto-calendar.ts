import type { ChatMessage } from './types.js';
import type { RecallBridge } from './auto-recall.js';

export const DEFAULT_CALENDAR_AGENDA_DAYS = 14;
export const DEFAULT_CALENDAR_AGENDA_BUDGET_CHARS = 8_000;
export const DEFAULT_CALENDAR_AGENDA_TIMEOUT_MS = 8_000;
export const CALENDAR_LIST_TOOL = 'list_calendar_events';
export const CALENDAR_AGENDA_TAG = 'calendar-agenda';

export interface CalendarAgendaEvent {
  summary?: string;
  startDate?: string;
  endDate?: string;
  location?: string | null;
  calendar?: string;
  uid?: string;
  allDay?: boolean;
}

export type CalendarAgendaFetch =
  | { available: true; events: CalendarAgendaEvent[]; from: string; to: string; calendar: string }
  | { available: false; reason: 'missing-tool' | 'timeout' | 'error' };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar date YYYY-MM-DD. */
export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Add whole days in local time (keeps wall-clock date stable across DST). */
export function addLocalDays(d: Date, days: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 0, 0, 0, 0);
  return out;
}

export function calendarAgendaWindow(
  now: Date = new Date(),
  days: number = DEFAULT_CALENDAR_AGENDA_DAYS,
): { from: string; to: string; fromIso: string; toIso: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = addLocalDays(start, days);
  // Inclusive end-of-day for the 14th day: to = start + days at 23:59:59
  const endInclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 0);
  const from = formatLocalDate(start);
  const to = formatLocalDate(end);
  return {
    from,
    to,
    fromIso: `${from}T00:00:00`,
    toIso: `${formatLocalDate(endInclusive)}T23:59:59`,
  };
}

export function historyHasCalendarAgenda(history: ChatMessage[]): boolean {
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          : '';
    if (text.includes(`<${CALENDAR_AGENDA_TAG}`)) return true;
  }
  return false;
}

function isMcpError(result: string): boolean {
  return /^(?:MCP tool error(?:\s|\()|MCP server not connected:|Unknown MCP tool:)/i.test(result.trim());
}

/** Parse EventKit display dates or ISO-ish strings into compact local pieces. */
export function compactEventTime(raw: string | undefined): { date: string; time: string | null; allDayHint: boolean } {
  if (!raw || !raw.trim()) return { date: '?', time: null, allDayHint: false };
  const s = raw.trim();

  // ISO-like: 2026-07-23T09:00:00 or 2026-07-23
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?/);
  if (iso) {
    const date = iso[1]!;
    if (!iso[2]) return { date, time: null, allDayHint: true };
    return { date, time: `${iso[2]}:${iso[3]}`, allDayHint: false };
  }

  // EventKit display: "Thursday, 23 July 2026 at 9:00:00 am"
  const display = s.match(
    /(\d{1,2})\s+(\w+)\s+(\d{4})(?:\s+at\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm))?/i,
  );
  if (display) {
    const months: Record<string, string> = {
      january: '01',
      february: '02',
      march: '03',
      april: '04',
      may: '05',
      june: '06',
      july: '07',
      august: '08',
      september: '09',
      october: '10',
      november: '11',
      december: '12',
    };
    const month = months[display[2]!.toLowerCase()];
    if (month) {
      const date = `${display[3]}-${month}-${pad2(Number(display[1]))}`;
      if (!display[4]) return { date, time: null, allDayHint: true };
      let hour = Number(display[4]);
      const minute = display[5]!;
      const ampm = display[6]!.toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      return { date, time: `${pad2(hour)}:${minute}`, allDayHint: false };
    }
  }

  return { date: s.slice(0, 32), time: null, allDayHint: false };
}

export function formatAgendaLine(event: CalendarAgendaEvent): string {
  const start = compactEventTime(event.startDate);
  const end = compactEventTime(event.endDate);
  const allDay = event.allDay === true || (start.allDayHint && !start.time);
  let when: string;
  if (allDay) {
    when = start.date === end.date || end.date === '?' ? `${start.date} all-day` : `${start.date}–${end.date} all-day`;
  } else if (start.time && end.time && start.date === end.date) {
    when = `${start.date} ${start.time}–${end.time}`;
  } else if (start.time && end.time) {
    when = `${start.date} ${start.time}–${end.date} ${end.time}`;
  } else {
    when = start.date;
  }

  const title = (event.summary ?? '').trim() || '(untitled)';
  const uid = (event.uid ?? '').trim();
  // Calendar name lives on the <calendar-agenda calendar="…"> tag, not each line.
  const parts = [when, title];
  if (uid) parts.push(`id:${uid}`);
  return parts.join(' | ');
}

/**
 * Bound injected agenda without cutting mid-line where possible.
 * Empty event lists still produce a sentinel block so the session does not re-fetch.
 */
export function buildCalendarAgendaBlock(
  events: CalendarAgendaEvent[],
  from: string,
  to: string,
  days: number = DEFAULT_CALENDAR_AGENDA_DAYS,
  budgetChars: number = DEFAULT_CALENDAR_AGENDA_BUDGET_CHARS,
  calendar?: string,
): string {
  if (budgetChars <= 0) return '';

  const calAttr = calendar?.trim() ? ` calendar="${calendar.trim()}"` : '';
  const header = `<${CALENDAR_AGENDA_TAG} days="${days}"${calAttr} from="${from}" to="${to}">`;
  const footer = `</${CALENDAR_AGENDA_TAG}>`;
  if (events.length === 0) {
    return `${header}\n(no events)\n${footer}`;
  }

  const lines: string[] = [];
  let used = header.length + footer.length + 2;
  for (const event of events) {
    const line = formatAgendaLine(event);
    if (used + line.length + 1 > budgetChars) {
      lines.push('… [calendar agenda truncated]');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return `${header}\n(no events)\n${footer}`;
  return `${header}\n${lines.join('\n')}\n${footer}`;
}

function parseEventsJson(raw: string): CalendarAgendaEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as CalendarAgendaEvent[];
    return [];
  } catch {
    // Sometimes MCP wraps JSON in prose — try to extract an array.
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        if (Array.isArray(parsed)) return parsed as CalendarAgendaEvent[];
      } catch {
        /* fall through */
      }
    }
    return [];
  }
}

/** Fetch the next N days of events from the configured default calendar. */
export async function fetchCalendarAgenda(
  bridge: RecallBridge,
  opts?: {
    now?: Date;
    days?: number;
    timeoutMs?: number;
    defaultCalendar?: string | null;
  },
): Promise<CalendarAgendaFetch> {
  if (!bridge.has(CALENDAR_LIST_TOOL)) return { available: false, reason: 'missing-tool' };

  const calendar = opts?.defaultCalendar?.trim() ?? '';
  const days = opts?.days ?? DEFAULT_CALENDAR_AGENDA_DAYS;
  const window = calendarAgendaWindow(opts?.now, days);
  // Fail closed: no default → empty sentinel (caller still injects so we do not re-fetch).
  if (!calendar) {
    return { available: true, events: [], from: window.from, to: window.to, calendar: '' };
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CALENDAR_AGENDA_TIMEOUT_MS;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.call(CALENDAR_LIST_TOOL, {
        from_date: window.fromIso,
        to_date: window.toIso,
      }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null) return { available: false, reason: 'timeout' };
    if (isMcpError(result)) return { available: false, reason: 'error' };
    const events = parseEventsJson(result);
    return { available: true, events, from: window.from, to: window.to, calendar };
  } catch {
    return { available: false, reason: 'error' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Index to splice a synthetic calendar message before the latest user turn. */
export function calendarAgendaInsertIndex(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') return i;
  }
  return history.length;
}
