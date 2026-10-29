import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventkit = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  getEvent: vi.fn(),
}));
vi.mock('../shared/eventkit.js', () => eventkit);

import { createCalendarMcpServer } from './calendar.js';

const initial = {
  uid: 'event-17',
  calendar: 'Home',
  summary: 'Hearing',
  startDate: '2031-04-03T10:00:00',
  endDate: '2031-04-03T11:00:00',
  location: null,
  description: null,
};

function tools() {
  const server = createCalendarMcpServer({ defaultCalendar: 'Home', safetyMode: 'confirm-destructive' } as never);
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
      >;
    }
  )._registeredTools;
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    uid: string;
    location: string | null;
    verification: { status: string; fields?: string[] };
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('calendar source-field readback', () => {
  it('keeps a missing document address unresolved and reads the created record back', async () => {
    eventkit.createEvent.mockResolvedValue(initial);
    eventkit.getEvent.mockResolvedValue(initial);
    const result = payload(
      await tools().create_event!.handler({
        summary: 'Hearing',
        start_date: '2031-04-03T10:00',
        end_date: '2031-04-03T11:00',
      }),
    );
    expect(eventkit.createEvent).toHaveBeenCalledWith(
      'Home',
      'Hearing',
      '2031-04-03T10:00',
      '2031-04-03T11:00',
      expect.objectContaining({ location: undefined }),
    );
    expect(eventkit.getEvent).toHaveBeenCalledWith('event-17');
    expect(result.location).toBeNull();
    expect(result.verification.status).toBe('confirmed');
  });

  it('changes only the named event field and reports a readback mismatch', async () => {
    eventkit.getEvent.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...initial, location: 'Old Hall' });
    eventkit.updateEvent.mockResolvedValue({ ...initial, location: 'Blackwater Bay' });
    const result = payload(await tools().update_event!.handler({ uid: 'event-17', location: 'Blackwater Bay' }));
    expect(eventkit.updateEvent).toHaveBeenCalledWith(
      'event-17',
      expect.objectContaining({
        location: 'Blackwater Bay',
        summary: undefined,
        description: undefined,
      }),
    );
    expect(result.verification).toEqual({ status: 'mismatch', fields: ['location'] });
  });

  it('stores the link as the event URL and in the description, and verifies both', async () => {
    const link = 'https://blackwater-bay.example/hearing';
    const created = { ...initial, description: `Room 4.\n\n${link}`, url: link };
    eventkit.createEvent.mockResolvedValue(created);
    eventkit.getEvent.mockResolvedValue({ ...created, url: null });
    const result = payload(
      await tools().create_event!.handler({
        summary: 'Hearing',
        start_date: '2031-04-03T10:00',
        end_date: '2031-04-03T11:00',
        description: 'Room 4.',
        url: link,
      }),
    );
    expect(eventkit.createEvent).toHaveBeenCalledWith(
      'Home',
      'Hearing',
      '2031-04-03T10:00',
      '2031-04-03T11:00',
      expect.objectContaining({ description: `Room 4.\n\n${link}`, url: link }),
    );
    expect(result.verification).toEqual({ status: 'mismatch', fields: ['url'] });
  });

  it('replaces the appended link on update', async () => {
    const old = 'https://blackwater-bay.example/hearing';
    const next = 'https://blackwater-bay.example/hearing-moved';
    const linked = { ...initial, description: `Room 4.\n\n${old}`, url: old };
    const moved = { ...initial, description: `Room 4.\n\n${next}`, url: next };
    eventkit.getEvent.mockResolvedValueOnce(linked).mockResolvedValueOnce(moved);
    eventkit.updateEvent.mockResolvedValue(moved);
    const result = payload(await tools().update_event!.handler({ uid: 'event-17', url: next }));
    expect(eventkit.updateEvent).toHaveBeenCalledWith(
      'event-17',
      expect.objectContaining({ description: `Room 4.\n\n${next}`, url: next }),
    );
    expect(result.verification.status).toBe('confirmed');
  });

  it('flags a location filled externally when the source supplied none', async () => {
    eventkit.createEvent.mockResolvedValue(initial);
    eventkit.getEvent.mockResolvedValue({ ...initial, location: 'Old Hall' });
    const result = payload(
      await tools().create_event!.handler({
        summary: 'Hearing',
        start_date: '2031-04-03T10:00',
        end_date: '2031-04-03T11:00',
      }),
    );
    expect(result.verification).toEqual({ status: 'mismatch', fields: ['location'] });
  });
});
