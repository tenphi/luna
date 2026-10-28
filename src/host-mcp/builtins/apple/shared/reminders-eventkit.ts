/**
 * TypeScript wrapper for Reminders via the vendored EventKit Swift helper.
 */
import { parseDateInput } from './applescript.js';
import { runCalendarHelper, withDisplayTimezone, type RecurrenceRule } from './eventkit.js';

/** Absolute instant, or minutes before the due date (as on events). */
export type ReminderAlert = { date: string } | { offsetMinutes: number };

export interface ReminderInfo {
  uid: string;
  name: string;
  list: string;
  completed: boolean;
  /** When it was checked off; null when never completed, or completed by a client that left it unset. */
  completedAt: string | null;
  priority: number;
  body?: string | null;
  url?: string | null;
  dueDate: string | null;
  /** Due on a date with no time (Reminders.app "no time") — dueDate carries no clock. */
  dueDateAllDay: boolean;
  /**
   * Deferred-until date, reported only when it differs from the due date — EventKit mirrors
   * an unset start onto the due, and that mirror is not news.
   */
  startDate: string | null;
  startDateAllDay: boolean;
  alerts?: ReminderAlert[];
  recurrence?: RecurrenceRule | null;
  created: string | null;
  lastModified: string | null;
}

/** Every list read states its own bounds, so a clipped answer cannot read as the whole list. */
export interface ReminderList {
  list: string;
  total: number;
  returned: number;
  truncated: boolean;
  reminders: ReminderInfo[];
}

export interface CreateReminderOptions {
  body?: string;
  dueDate?: string;
  startDate?: string;
  priority?: number;
  url?: string;
  alerts?: ReminderAlert[];
  recurrence?: RecurrenceRule;
}

export interface UpdateReminderOptions {
  name?: string;
  body?: string | null;
  dueDate?: string | null;
  startDate?: string | null;
  priority?: number;
  url?: string | null;
  alerts?: ReminderAlert[] | null;
  recurrence?: RecurrenceRule | null;
}

export interface DeleteReminderResult {
  deleted: boolean;
  uid: string;
  name: string;
}

export interface ListRemindersOptions {
  includeCompleted?: boolean;
  limit?: number;
}

export interface CompletedRemindersOptions {
  /** A single calendar day, expanded to its full span in the install timezone. */
  on?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function limitArgs(limit: number | undefined): string[] {
  return limit === undefined ? [] : ['--limit', String(limit)];
}

/** A day + `--due`/`--start` pair: naive ISO, plus the all-day flag when no clock was named. */
function dateArgs(flag: string, value: string): string[] {
  const { iso, hasTime } = parseDateInput(value);
  return hasTime ? [flag, iso] : [flag, iso, `${flag}-all-day`];
}

export async function listReminders(listName: string, options?: ListRemindersOptions): Promise<ReminderList> {
  return JSON.parse(
    await runCalendarHelper(
      withDisplayTimezone([
        'list-reminders',
        '--list',
        listName,
        '--include-completed',
        options?.includeCompleted ? 'true' : 'false',
        ...limitArgs(options?.limit),
      ]),
    ),
  ) as ReminderList;
}

/** Completed reminders by completion date (newest first); open bounds mean "any". */
export async function listCompletedReminders(
  listName: string,
  options?: CompletedRemindersOptions,
): Promise<ReminderList> {
  const args = ['list-completed-reminders', '--list', listName];
  // A named day is the whole day: bounds the caller cannot get subtly wrong by hand.
  if (options?.on) {
    const { date } = parseDateInput(options.on);
    args.push('--from', `${date}T00:00:00`, '--to', `${date}T23:59:59`);
  } else {
    if (options?.from) args.push('--from', parseDateInput(options.from).iso);
    if (options?.to) args.push('--to', parseDateInput(options.to).iso);
  }
  args.push(...limitArgs(options?.limit));
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(args))) as ReminderList;
}

export async function searchReminders(query: string, listName: string, limit?: number): Promise<ReminderList> {
  return JSON.parse(
    await runCalendarHelper(
      withDisplayTimezone(['search-reminders', '--query', query, '--list', listName, ...limitArgs(limit)]),
    ),
  ) as ReminderList;
}

export async function getReminder(uid: string): Promise<ReminderInfo> {
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(['get-reminder', '--uid', uid]))) as ReminderInfo;
}

export async function createReminder(
  listName: string,
  name: string,
  options?: CreateReminderOptions,
): Promise<ReminderInfo> {
  const args = ['create-reminder', '--list', listName, '--title', name];
  if (options?.body) args.push('--notes', options.body);
  if (options?.dueDate) args.push(...dateArgs('--due', options.dueDate));
  if (options?.startDate) args.push(...dateArgs('--start', options.startDate));
  if (options?.priority !== undefined) args.push('--priority', String(options.priority));
  if (options?.url) args.push('--url', options.url);
  if (options?.alerts) args.push('--alerts', JSON.stringify(options.alerts.map(normalizeAlert)));
  if (options?.recurrence) args.push('--recurrence', JSON.stringify(options.recurrence));
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(args))) as ReminderInfo;
}

export async function updateReminder(uid: string, updates: UpdateReminderOptions): Promise<ReminderInfo> {
  const args = ['update-reminder', '--uid', uid];
  if (updates.name !== undefined) args.push('--title', updates.name);
  if (updates.body === null) {
    args.push('--clear-notes');
  } else if (updates.body !== undefined) {
    args.push('--notes', updates.body);
  }
  if (updates.dueDate === null) {
    args.push('--clear-due');
  } else if (updates.dueDate !== undefined) {
    args.push(...dateArgs('--due', updates.dueDate));
  }
  if (updates.startDate === null) {
    args.push('--clear-start');
  } else if (updates.startDate !== undefined) {
    args.push(...dateArgs('--start', updates.startDate));
  }
  if (updates.priority !== undefined) args.push('--priority', String(updates.priority));
  if (updates.url === null) {
    args.push('--clear-url');
  } else if (updates.url !== undefined) {
    args.push('--url', updates.url);
  }
  if (updates.alerts === null) {
    args.push('--clear-alerts');
  } else if (updates.alerts !== undefined) {
    args.push('--alerts', JSON.stringify(updates.alerts.map(normalizeAlert)));
  }
  if (updates.recurrence === null) {
    args.push('--clear-recurrence');
  } else if (updates.recurrence !== undefined) {
    args.push('--recurrence', JSON.stringify(updates.recurrence));
  }
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(args))) as ReminderInfo;
}

/** Alert dates travel as naive ISO, like every other date the helper reads. */
function normalizeAlert(alert: ReminderAlert): ReminderAlert {
  return 'date' in alert ? { date: parseDateInput(alert.date).iso } : alert;
}

export async function completeReminder(uid: string): Promise<ReminderInfo> {
  return JSON.parse(await runCalendarHelper(withDisplayTimezone(['complete-reminder', '--uid', uid]))) as ReminderInfo;
}

export async function uncompleteReminder(uid: string): Promise<ReminderInfo> {
  return JSON.parse(
    await runCalendarHelper(withDisplayTimezone(['uncomplete-reminder', '--uid', uid])),
  ) as ReminderInfo;
}

export async function deleteReminder(uid: string): Promise<DeleteReminderResult> {
  return JSON.parse(await runCalendarHelper(['delete-reminder', '--uid', uid])) as DeleteReminderResult;
}
