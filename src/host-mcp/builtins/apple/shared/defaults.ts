/**
 * Require a configured Apple default calendar/list name.
 * Fail closed with a clear config error when unset.
 */
export function requireDefault(name: string | null | undefined, kind: 'calendar' | 'reminders'): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    const key = kind === 'calendar' ? 'apple.apps.calendar.defaultCalendar' : 'apple.apps.reminders.defaultList';
    throw new Error(`${key} is not configured. Set it in config/local.jsonc (e.g. "Household").`);
  }
  return trimmed;
}

/** Guard that a reminder belongs to the configured default list. Fail closed if list is missing. */
export function assertReminderInDefaultList(reminder: { list?: string | null }, defaultList: string): void {
  const list = (reminder.list ?? '').trim();
  if (!list || list !== defaultList) {
    throw new Error('Reminder not in configured default list');
  }
}

/** Guard that an event belongs to the configured default calendar. Fail closed if calendar is missing. */
export function assertEventInDefaultCalendar(event: { calendar?: string | null }, defaultCalendar: string): void {
  const calendar = (event.calendar ?? '').trim();
  if (!calendar || calendar !== defaultCalendar) {
    throw new Error('Event not in configured default calendar');
  }
}
