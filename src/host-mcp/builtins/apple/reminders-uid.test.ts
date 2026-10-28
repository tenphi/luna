/**
 * Unit tests for uid-based / default-scoped reminders MCP registration (no EventKit/TCC).
 */
import { describe, expect, it } from 'vitest';

import { createRemindersMcpServer } from './servers/reminders.js';

type RegisteredTool = {
  inputSchema?: { shape?: Record<string, unknown> };
};

function registeredTools(server: ReturnType<typeof createRemindersMcpServer>): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

describe('apple reminders MCP default-scoped uid tools', () => {
  it('registers uid mutators and drops list management tools', () => {
    const tools = registeredTools(
      createRemindersMcpServer({ enabled: true, safetyMode: 'normal', defaultList: 'Household' }),
    );

    expect(tools.list_lists).toBeUndefined();
    expect(tools.create_list).toBeUndefined();
    expect(tools.delete_list).toBeUndefined();

    expect(tools.list_reminders).toBeDefined();
    expect(Object.keys(tools.list_reminders!.inputSchema?.shape ?? {})).toEqual([
      'include_completed',
      'completed_on',
      'completed_from',
      'completed_to',
      'limit',
    ]);

    expect(tools.create_reminder).toBeDefined();
    expect(Object.keys(tools.create_reminder!.inputSchema?.shape ?? {})).not.toContain('list');

    for (const name of ['get_reminder', 'update_reminder', 'complete_reminder', 'uncomplete_reminder'] as const) {
      expect(tools[name]).toBeDefined();
      expect(Object.keys(tools[name]!.inputSchema?.shape ?? {})).toContain('uid');
      expect(Object.keys(tools[name]!.inputSchema?.shape ?? {})).not.toContain('list');
    }

    expect(tools.delete_reminder).toBeDefined();
    expect(Object.keys(tools.delete_reminder!.inputSchema?.shape ?? {})).toContain('uid');

    expect(tools.search_reminders).toBeDefined();
    expect(Object.keys(tools.search_reminders!.inputSchema?.shape ?? {})).toEqual(['query', 'limit']);
  });

  it('omits delete_reminder in read-only safety mode', () => {
    const tools = registeredTools(
      createRemindersMcpServer({ enabled: true, safetyMode: 'read-only', defaultList: 'Household' }),
    );
    expect(tools.delete_reminder).toBeUndefined();
    expect(tools.get_reminder).toBeDefined();
    expect(tools.complete_reminder).toBeDefined();
  });
});
