import { describe, expect, it } from 'vitest';

import { describeCron, describeRunTime, formatScheduledTasks, type ScheduledTaskView } from './command.js';

function task(overrides: Partial<ScheduledTaskView>): ScheduledTaskView {
  return {
    id: 'task-1',
    status: 'pending',
    process_after: '2026-08-13T07:30:00.000Z',
    recurrence: null,
    content: JSON.stringify({ prompt: 'Do the thing' }),
    agentGroupId: 'ag-1',
    agentName: 'Luna',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('scheduled task command formatting', () => {
  const now = new Date('2026-08-12T08:00:00.000Z');

  it('describes common recurring schedules without exposing cron syntax', () => {
    expect(describeCron('30 9 * * *')).toBe('Every day at 09:30');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 8 * * 1,3,5')).toBe('Every Monday, Wednesday, Friday at 08:00');
  });

  it('formats next runs in the configured timezone with a relative time', () => {
    expect(describeRunTime('2026-08-13T07:30:00.000Z', 'Europe/Berlin', now)).toBe('tomorrow at 09:30 (in 23h 30m)');
  });

  it('lists recurring, one-shot, and paused tasks with stable ids', () => {
    const text = formatScheduledTasks(
      [
        task({ id: 'daily-digest', recurrence: '30 9 * * *', content: JSON.stringify({ prompt: 'Morning digest' }) }),
        task({
          id: 'one-off',
          process_after: '2026-08-12T12:00:00.000Z',
          content: JSON.stringify({ prompt: 'Call the dentist' }),
        }),
        task({
          id: 'paused-weekly',
          status: 'paused',
          recurrence: '0 18 * * 5',
          content: JSON.stringify({ prompt: 'Weekly review' }),
        }),
      ],
      { timezone: 'Europe/Berlin', now },
    );

    expect(text).toContain('Scheduled tasks (3)');
    expect(text).toContain('Schedule: Every day at 09:30');
    expect(text).toContain('Schedule: Once');
    expect(text).toContain('Schedule: Paused · Every Friday at 18:00');
    expect(text).toContain('Next: today at 14:00 (in 4h)');
    expect(text).toContain('ID: daily-digest');
    expect(text).toContain('ID: one-off');
    expect(text).toContain('ID: paused-weekly');
  });
});
