import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { listTasks, type TaskListRow } from '../../db/session-db.js';
import { getActiveSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openSession } from '../../session-manager.js';

export interface ScheduledTaskView extends TaskListRow {
  agentGroupId: string;
  agentName: string;
  sessionId: string;
}

interface FormatOptions {
  timezone?: string;
  now?: Date;
  skippedSessions?: number;
}

const WEEKDAYS: Record<string, string> = {
  '0': 'Sunday',
  '1': 'Monday',
  '2': 'Tuesday',
  '3': 'Wednesday',
  '4': 'Thursday',
  '5': 'Friday',
  '6': 'Saturday',
  '7': 'Sunday',
};

function twoDigits(value: string): string {
  return value.padStart(2, '0');
}

function clock(hour: string, minute: string): string {
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

/** Turn the cron forms Luna commonly creates into text a person can scan. */
export function describeCron(cron: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cron.trim().split(/\s+/);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek || rest.length > 0) {
    return 'Recurring on a custom schedule';
  }

  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const count = Number(everyMinutes[1]);
    return `Every ${count} minute${count === 1 ? '' : 's'}`;
  }

  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (minute === '0' && everyHours && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const count = Number(everyHours[1]);
    return `Every ${count} hour${count === 1 ? '' : 's'}`;
  }

  const fixedTime = /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour);
  if (!fixedTime) return 'Recurring on a custom schedule';
  const at = `at ${clock(hour, minute)}`;

  if (dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') return `Every day ${at}`;
    if (dayOfWeek === '1-5') return `Weekdays ${at}`;
    if (dayOfWeek === '0,6' || dayOfWeek === '6,0') return `Weekends ${at}`;

    const days = dayOfWeek.split(',').map((day) => WEEKDAYS[day]);
    if (days.every(Boolean)) return `Every ${days.join(', ')} ${at}`;
  }

  if (/^\d{1,2}$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    return `Monthly on day ${Number(dayOfMonth)} ${at}`;
  }

  if (/^\d{1,2}$/.test(dayOfMonth) && /^\d{1,2}$/.test(month) && dayOfWeek === '*') {
    const date = new Date(Date.UTC(2024, Number(month) - 1, Number(dayOfMonth)));
    if (!Number.isNaN(date.getTime())) {
      const label = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
      return `Yearly on ${label} ${at}`;
    }
  }

  return 'Recurring on a custom schedule';
}

function localParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function localDayNumber(date: Date, timezone: string): number {
  const parts = localParts(date, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
}

function relativeDuration(target: Date, now: Date): string {
  const totalMinutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (Math.abs(totalMinutes) < 1) return 'now';

  const future = totalMinutes > 0;
  const absolute = Math.abs(totalMinutes);
  const days = Math.floor(absolute / 1_440);
  const hours = Math.floor((absolute % 1_440) / 60);
  const minutes = absolute % 60;
  const pieces: string[] = [];
  if (days) pieces.push(`${days}d`);
  if (hours) pieces.push(`${hours}h`);
  if (minutes && pieces.length < 2) pieces.push(`${minutes}m`);
  const duration = pieces.join(' ') || '<1m';
  return future ? `in ${duration}` : `${duration} ago`;
}

/** Local next-run text with today/tomorrow where that is easier to read. */
export function describeRunTime(iso: string | null, timezone: string, now: Date): string {
  if (!iso) return 'time not set';
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return 'invalid time';

  const parts = localParts(target, timezone);
  const dayDifference = localDayNumber(target, timezone) - localDayNumber(now, timezone);
  const day =
    dayDifference === 0
      ? 'today'
      : dayDifference === 1
        ? 'tomorrow'
        : dayDifference === -1
          ? 'yesterday'
          : new Intl.DateTimeFormat('en-GB', {
              timeZone: timezone,
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              ...(parts.year !== localParts(now, timezone).year ? { year: 'numeric' as const } : {}),
            }).format(target);
  return `${day} at ${parts.hour}:${parts.minute} (${relativeDuration(target, now)})`;
}

function taskPrompt(content: string): string {
  try {
    const parsed = JSON.parse(content) as { prompt?: unknown };
    if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
      const normalized = parsed.prompt.replace(/\s+/g, ' ').trim();
      return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized;
    }
  } catch {
    // A corrupt task should still appear in the list instead of hiding it.
  }
  return '(task instructions unavailable)';
}

export function formatScheduledTasks(tasks: ScheduledTaskView[], options: FormatOptions = {}): string {
  const timezone = options.timezone ?? TIMEZONE;
  const now = options.now ?? new Date();
  const skipped = options.skippedSessions ?? 0;
  if (tasks.length === 0) {
    return `No scheduled tasks.\nTimezone: ${timezone}${skipped ? `\nCould not inspect ${skipped} session(s).` : ''}`;
  }

  const sorted = [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'paused' ? 1 : -1;
    return (a.process_after ?? '').localeCompare(b.process_after ?? '');
  });
  const showAgent = new Set(sorted.map((task) => task.agentGroupId)).size > 1;
  const lines = [`Scheduled tasks (${sorted.length})`, `Timezone: ${timezone}`, ''];

  sorted.forEach((task, index) => {
    const recurring = task.recurrence ? describeCron(task.recurrence) : 'Once';
    const schedule = task.status === 'paused' ? `Paused · ${recurring}` : recurring;
    lines.push(`${index + 1}. ${taskPrompt(task.content)}`);
    lines.push(`   Schedule: ${schedule}`);
    lines.push(
      `   ${task.status === 'paused' ? 'Next when resumed' : 'Next'}: ${describeRunTime(task.process_after, timezone, now)}`,
    );
    if (showAgent) lines.push(`   Agent: ${task.agentName}`);
    lines.push(`   ID: ${task.id}`);
    if (index < sorted.length - 1) lines.push('');
  });

  if (skipped) lines.push('', `Could not inspect ${skipped} session(s).`);
  return lines.join('\n');
}

/** Collect every live task series from every active session in the install. */
export function formatScheduledTaskList(): string {
  const tasks: ScheduledTaskView[] = [];
  let skippedSessions = 0;

  for (const session of getActiveSessions()) {
    try {
      const db = openSession(session.agent_group_id, session.id);
      try {
        const agentName = getAgentGroup(session.agent_group_id)?.name ?? session.agent_group_id;
        for (const task of listTasks(db)) {
          tasks.push({ ...task, agentGroupId: session.agent_group_id, agentName, sessionId: session.id });
        }
      } finally {
        db.close();
      }
    } catch (err) {
      skippedSessions += 1;
      log.warn('Failed to inspect scheduled tasks for session', { sessionId: session.id, err });
    }
  }

  return formatScheduledTasks(tasks, { skippedSessions });
}
