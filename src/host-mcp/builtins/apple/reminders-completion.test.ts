/**
 * Unit tests for the reminder tool surface: completion windows, list bounds and the
 * helper args every write builds (no EventKit/TCC).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCalendarHelper = vi.fn<(args: string[]) => Promise<string>>();

vi.mock('./shared/eventkit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared/eventkit.js')>();
  return { ...actual, runCalendarHelper };
});

const { createRemindersMcpServer } = await import('./servers/reminders.js');
const remindersEk = await import('./shared/reminders-eventkit.js');

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;

function tool(name: string): ToolHandler {
  const server = createRemindersMcpServer({ enabled: true, safetyMode: 'normal', defaultList: 'Household' });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;
  return tools[name]!.handler;
}

/** Args of the single helper invocation made by the call under test. */
function helperArgs(): string[] {
  expect(runCalendarHelper).toHaveBeenCalledTimes(1);
  return runCalendarHelper.mock.calls[0]![0];
}

function valueOf(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx < 0 ? undefined : args[idx + 1];
}

describe('reminder completion reads', () => {
  beforeEach(() => {
    runCalendarHelper.mockReset();
    runCalendarHelper.mockResolvedValue('{"list":"Household","total":0,"returned":0,"truncated":false,"reminders":[]}');
  });

  it('expands a named day into that whole day — "done yesterday" needs no arithmetic', async () => {
    await tool('list_reminders')({ completed_on: '12 August 2026' });

    const args = helperArgs();
    expect(args[0]).toBe('list-completed-reminders');
    expect(valueOf(args, '--from')).toBe('2026-08-12T00:00:00');
    expect(valueOf(args, '--to')).toBe('2026-08-12T23:59:59');
  });

  it('accepts an explicit completion span', async () => {
    await tool('list_reminders')({
      completed_from: '13 August 2026 at 00:00',
      completed_to: '13 August 2026 at 23:59',
    });

    const args = helperArgs();
    expect(valueOf(args, '--from')).toBe('2026-08-13T00:00:00');
    expect(valueOf(args, '--to')).toBe('2026-08-13T23:59:00');
  });

  it('prefers the window over include_completed, and lists normally without one', async () => {
    await tool('list_reminders')({ include_completed: true, completed_on: '2026-08-12' });
    expect(helperArgs()[0]).toBe('list-completed-reminders');

    runCalendarHelper.mockClear();
    await tool('list_reminders')({ include_completed: true });
    const args = helperArgs();
    expect(args[0]).toBe('list-reminders');
    expect(valueOf(args, '--include-completed')).toBe('true');
  });

  it('bounds every list read, and passes an explicit limit through', async () => {
    await tool('list_reminders')({});
    expect(valueOf(helperArgs(), '--limit')).toBe('200');

    runCalendarHelper.mockClear();
    await tool('list_reminders')({ completed_on: '2026-08-12', limit: 25 });
    expect(valueOf(helperArgs(), '--limit')).toBe('25');

    runCalendarHelper.mockClear();
    await tool('search_reminders')({ query: 'milk' });
    expect(valueOf(helperArgs(), '--limit')).toBe('200');
  });

  it('reports the bounds the helper found rather than just the rows', async () => {
    runCalendarHelper.mockResolvedValue(
      '{"list":"Household","total":812,"returned":2,"truncated":true,"reminders":[{},{}]}',
    );

    const result = await tool('list_reminders')({ include_completed: true, limit: 2 });
    const payload = JSON.parse(result.content[0]!.text!) as { total: number; truncated: boolean };
    expect(payload).toMatchObject({ total: 812, truncated: true });
  });

  it('leaves open bounds off the command line', async () => {
    await remindersEk.listCompletedReminders('Household');

    const args = helperArgs();
    expect(args).toEqual(expect.arrayContaining(['list-completed-reminders', '--list', 'Household']));
    expect(args).not.toContain('--from');
    expect(args).not.toContain('--to');
    expect(args).not.toContain('--limit');
  });

  it('passes the install timezone on reminder reads and writes', async () => {
    runCalendarHelper.mockResolvedValue('{}');
    await remindersEk.getReminder('uid-1');
    await remindersEk.completeReminder('uid-1');

    for (const [args] of runCalendarHelper.mock.calls) {
      expect(args).toContain('--display-timezone');
    }
  });
});

describe('reminder writes', () => {
  beforeEach(() => {
    runCalendarHelper.mockReset();
    runCalendarHelper.mockResolvedValue('{}');
  });

  it('marks a day with no clock as all-day, and a named time as timed', async () => {
    await tool('create_reminder')({ name: '🛒 Order dinner', due_date: '13 August 2026' });
    let args = helperArgs();
    expect(valueOf(args, '--due')).toBe('2026-08-13T00:00:00');
    expect(args).toContain('--due-all-day');

    runCalendarHelper.mockClear();
    await tool('create_reminder')({ name: '🛒 Order dinner', due_date: '14 May 2031 at 6:40 PM' });
    args = helperArgs();
    expect(valueOf(args, '--due')).toBe('2031-05-14T18:40:00');
    expect(args).not.toContain('--due-all-day');
  });

  it('writes url, start date, alerts and recurrence', async () => {
    await tool('create_reminder')({
      name: '🧾 File taxes',
      due_date: '1 April 2027 at 9:00 AM',
      start_date: '1 March 2027',
      url: 'https://example.com/forms',
      alerts: [{ offsetMinutes: 30 }, { date: '1 April 2027 at 8:00 AM' }],
      recurrence: { frequency: 'yearly', interval: 1 },
    });

    const args = helperArgs();
    expect(valueOf(args, '--url')).toBe('https://example.com/forms');
    expect(valueOf(args, '--start')).toBe('2027-03-01T00:00:00');
    expect(args).toContain('--start-all-day');
    expect(JSON.parse(valueOf(args, '--alerts')!)).toEqual([{ offsetMinutes: 30 }, { date: '2027-04-01T08:00:00' }]);
    expect(JSON.parse(valueOf(args, '--recurrence')!)).toMatchObject({ frequency: 'yearly', interval: 1 });
  });

  it('clears fields on null, and leaves untouched fields alone', async () => {
    await remindersEk.updateReminder('uid-1', {
      body: null,
      dueDate: null,
      startDate: null,
      url: null,
      alerts: null,
      recurrence: null,
    });

    const args = helperArgs();
    for (const flag of [
      '--clear-notes',
      '--clear-due',
      '--clear-start',
      '--clear-url',
      '--clear-alerts',
      '--clear-recurrence',
    ]) {
      expect(args).toContain(flag);
    }

    runCalendarHelper.mockClear();
    await remindersEk.updateReminder('uid-1', { name: 'Renamed' });
    expect(helperArgs().filter((a) => a.startsWith('--clear-'))).toEqual([]);
  });
});
