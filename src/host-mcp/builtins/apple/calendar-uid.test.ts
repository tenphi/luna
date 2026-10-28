/**
 * Unit tests for default-scoped calendar MCP tool registration (no EventKit/TCC required).
 */
import { describe, expect, it } from 'vitest';

import { createCalendarMcpServer } from './servers/calendar.js';

type RegisteredTool = {
  inputSchema?: { shape?: Record<string, unknown> };
};

function registeredTools(server: ReturnType<typeof createCalendarMcpServer>): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

describe('apple calendar MCP default-scoped tools', () => {
  it('registers list/create without calendar arg; get/update/delete require uid', () => {
    const tools = registeredTools(
      createCalendarMcpServer({ enabled: true, safetyMode: 'normal', defaultCalendar: 'Household' }),
    );

    expect(tools.list_calendars).toBeUndefined();
    expect(tools.list_all_events).toBeUndefined();

    expect(tools.list_events).toBeDefined();
    expect(Object.keys(tools.list_events!.inputSchema?.shape ?? {}).sort()).toEqual(['from_date', 'to_date']);

    expect(tools.create_event).toBeDefined();
    const createKeys = Object.keys(tools.create_event!.inputSchema?.shape ?? {});
    expect(createKeys).not.toContain('calendar');
    expect(createKeys).toEqual(
      expect.arrayContaining([
        'summary',
        'start_date',
        'end_date',
        'location',
        'description',
        'all_day',
        'timezone',
        'url',
        'alerts',
        'recurrence',
      ]),
    );
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).toContain('timezone');

    expect(tools.get_event).toBeDefined();
    expect(Object.keys(tools.get_event!.inputSchema?.shape ?? {})).toEqual(['uid']);

    expect(tools.update_event).toBeDefined();
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).toContain('uid');
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).toContain('url');
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).toContain('alerts');
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).toContain('recurrence');
    expect(Object.keys(tools.update_event!.inputSchema?.shape ?? {})).not.toContain('calendar');

    expect(tools.delete_event).toBeDefined();
    expect(Object.keys(tools.delete_event!.inputSchema?.shape ?? {})).toContain('uid');

    expect(tools.search_events).toBeDefined();
    expect(Object.keys(tools.search_events!.inputSchema?.shape ?? {})).toEqual(['query']);
  });

  it('omits delete_event in read-only safety mode', () => {
    const tools = registeredTools(
      createCalendarMcpServer({ enabled: true, safetyMode: 'read-only', defaultCalendar: 'Household' }),
    );
    expect(tools.delete_event).toBeUndefined();
    expect(tools.get_event).toBeDefined();
    expect(tools.update_event).toBeDefined();
  });
});
