const clocks = new Map<string, Intl.DateTimeFormat>();
function clock(timeZone: string): Intl.DateTimeFormat {
  if (!clocks.has(timeZone)) clocks.set(timeZone, new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return clocks.get(timeZone)!;
}
export function isValidTimezone(zone: string): boolean {
  if (!zone) return false;
  try { clock(zone).format(0); return true; } catch { return false; }
}
export const resolveTimezone = (zone: string): string => isValidTimezone(zone) ? zone : 'UTC';

export function formatLocalTime(timestamp: string, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(zone), dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(timestamp));
}

function wallTime(instant: number, zone: string): number {
  const parts = clock(zone).formatToParts(instant);
  const number = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === name)!.value);
  return Date.UTC(number('year'), number('month') - 1, number('day'), number('hour'), number('minute'), number('second')) + ((instant % 1000) + 1000) % 1000;
}

/** Resolve wall-clock input, preferring the earlier instant during a repeated hour. */
export function parseZonedToUtc(input: string, timezone: string): Date {
  const text = input.trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text);
  const wall = Date.parse(`${text}Z`);
  if (!Number.isFinite(wall)) return new Date(NaN);
  const zone = resolveTimezone(timezone);
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const probe = wall + delta;
    offsets.add(wallTime(probe, zone) - probe);
  }
  const candidates = Array.from(offsets, (offset) => wall - offset).sort((a, b) => a - b);
  const exact = candidates.find((candidate) => wallTime(candidate, zone) === wall);
  // Move a nonexistent spring-forward time forward into the next valid hour.
  return new Date(exact ?? candidates.at(-1)!);
}

export function formatLocalDateParts(when: Date, timezone: string): { date: string; weekday: string } {
  const fields = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  }).formatToParts(when);
  const value = (type: Intl.DateTimeFormatPartTypes) => fields.find((field) => field.type === type)?.value ?? '';
  return { date: [value('year'), value('month'), value('day')].join('-'), weekday: value('weekday') };
}

export const TIMEZONE = [process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone].find(
  (zone): zone is string => typeof zone === 'string' && isValidTimezone(zone),
) ?? 'UTC';
