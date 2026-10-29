import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod';

const remindersEk = vi.hoisted(() => ({
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  getReminder: vi.fn(),
}));
vi.mock('../shared/reminders-eventkit.js', () => remindersEk);

import { createRemindersMcpServer } from './reminders.js';

const tickets = 'https://blackwater-bay.example/tickets/2031';
const venue = 'https://blackwater-bay.example/venue';

const saved = {
  uid: 'reminder-17',
  name: 'Decide on tickets',
  list: 'Household',
  body: `Two seats.\n\n${tickets}`,
  url: tickets,
};

type Tool = {
  inputSchema: z.ZodObject;
  handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

function tools() {
  const server = createRemindersMcpServer({ enabled: true, safetyMode: 'normal', defaultList: 'Household' });
  return (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
}

beforeEach(() => {
  vi.resetAllMocks();
  remindersEk.createReminder.mockResolvedValue(saved);
  remindersEk.updateReminder.mockResolvedValue(saved);
  remindersEk.getReminder.mockResolvedValue(saved);
});

describe('reminder links', () => {
  it('appends the link to the notes Reminders.app shows', async () => {
    await tools().create_reminder!.handler({ name: 'Decide on tickets', url: tickets });
    expect(remindersEk.createReminder).toHaveBeenCalledWith(
      'Household',
      'Decide on tickets',
      expect.objectContaining({ body: tickets, url: tickets }),
    );

    await tools().create_reminder!.handler({ name: 'Decide on tickets', body: 'Two seats.', url: tickets });
    expect(remindersEk.createReminder).toHaveBeenLastCalledWith(
      'Household',
      'Decide on tickets',
      expect.objectContaining({ body: `Two seats.\n\n${tickets}`, url: tickets }),
    );
  });

  it('replaces the appended link on update', async () => {
    await tools().update_reminder!.handler({ uid: 'reminder-17', url: venue });
    expect(remindersEk.updateReminder).toHaveBeenCalledWith(
      'reminder-17',
      expect.objectContaining({ body: `Two seats.\n\n${venue}`, url: venue }),
    );
  });

  it('removes the appended link when the url is cleared', async () => {
    await tools().update_reminder!.handler({ uid: 'reminder-17', url: null });
    expect(remindersEk.updateReminder).toHaveBeenCalledWith(
      'reminder-17',
      expect.objectContaining({ body: 'Two seats.', url: null }),
    );
  });

  it('leaves the notes alone when neither body nor url changes', async () => {
    await tools().update_reminder!.handler({ uid: 'reminder-17', due_date: '1 November 2031' });
    expect(remindersEk.updateReminder).toHaveBeenCalledWith(
      'reminder-17',
      expect.objectContaining({ body: undefined, url: undefined }),
    );
  });

  it('rejects a link EventKit could not store', () => {
    const schema = tools().create_reminder!.inputSchema;
    expect(schema.safeParse({ name: 'Decide on tickets', url: 'blackwater-bay.example/tickets' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Decide on tickets', url: tickets }).success).toBe(true);
  });
});
