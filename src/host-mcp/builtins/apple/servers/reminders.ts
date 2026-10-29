/**
 * In-process Apple Reminders MCP server (EventKit, default-list only).
 *
 * uid-based reads/writes via the vendored `calendar-helper` Swift binary.
 * Always scoped to config.defaultList.
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-reminders-mcp` 1.0.0),
 * vendored in-tree by Luna. Raw tool names preserved for the tool-alias map.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import { errorResult, textResult } from '../../shared/cli.js';
import { assertReminderInDefaultList, requireDefault } from '../shared/defaults.js';
import { joinNotes, normalizeLink, updatedNotes } from '../shared/notes-link.js';
import * as remindersEk from '../shared/reminders-eventkit.js';
import { confirmArg, confirmGuard, isReadOnly } from '../shared/safety.js';
import { linkSchema, recurrenceSchema } from '../shared/schemas.js';
import type { AppleAppConfig } from '../shared/types.js';

/** A fixed instant, or minutes before the due date. Reminders.app writes the former. */
const alertSchema = z.union([
  z.object({ date: z.string().describe("When to alert (e.g. '13 August 2026 at 8:30 AM')") }),
  z.object({ offsetMinutes: z.number().describe('Minutes before the due date to alert; needs a due date') }),
]);

const dueDateArg = z
  .string()
  .describe(
    "Due date — a day alone ('14 May 2031') is all-day; add a time ('14 May 2031 at 6:40 PM') to make it timed",
  );

const startDateArg = z
  .string()
  .describe(
    'Start/deferred-until date — rarely needed; the due date is the deadline. Reported back only when it differs from the due date.',
  );

const urlArg = linkSchema.describe(
  'Link to attach (absolute URL). Appended to the notes, the only place Reminders.app shows links — do not also paste it into body',
);

/** Big enough for any real list, small enough that a completed backlog cannot flood the turn. */
const DEFAULT_LIST_LIMIT = 200;

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe(`Max reminders to return (default ${DEFAULT_LIST_LIMIT}); the result reports total and truncated`);

export function createRemindersMcpServer(config: AppleAppConfig): McpServer {
  const mode = config.safetyMode;
  const server = new McpServer({ name: 'apple-reminders', version: '1.0.0' }, { capabilities: {} });

  function defaultList(): string {
    return requireDefault(config.defaultList, 'reminders');
  }

  async function loadInDefaultList(uid: string): Promise<remindersEk.ReminderInfo> {
    const list = defaultList();
    const reminder = await remindersEk.getReminder(uid);
    assertReminderInDefaultList(reminder, list);
    return reminder;
  }

  server.registerTool(
    'list_reminders',
    {
      description:
        'List reminders in the configured default list, open work first (soonest due first, undated last). Each reminder includes completedAt (when it was checked off). To answer "what did I get done yesterday / today / this week", pass completed_on for a single day, or completed_from/completed_to for a span: that returns only reminders completed in the window, newest first.',
      inputSchema: {
        include_completed: z.boolean().optional().describe('Include completed reminders (default false)'),
        completed_on: z
          .string()
          .optional()
          .describe("A single day whose completions to return, e.g. '12 August 2026' or '2026-08-12'"),
        completed_from: z.string().optional().describe('Only reminders completed at/after this time'),
        completed_to: z.string().optional().describe('Only reminders completed at/before this time'),
        limit: limitArg,
      },
    },
    async ({ include_completed, completed_on, completed_from, completed_to, limit }) => {
      try {
        // A completion window is a different question than "the list" — answer it from
        // EventKit's completed-reminders predicate instead of filtering the whole backlog.
        if (completed_on || completed_from || completed_to) {
          return textResult(
            await remindersEk.listCompletedReminders(defaultList(), {
              on: completed_on,
              from: completed_from,
              to: completed_to,
              limit: limit ?? DEFAULT_LIST_LIMIT,
            }),
          );
        }
        return textResult(
          await remindersEk.listReminders(defaultList(), {
            includeCompleted: include_completed,
            limit: limit ?? DEFAULT_LIST_LIMIT,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_reminder',
    {
      description: 'Get full details of a reminder by its uid (from list/search/create or the session agenda)',
      inputSchema: {
        uid: z.string().describe('Reminder uid (EventKit calendarItemIdentifier)'),
      },
    },
    async ({ uid }) => {
      try {
        return textResult(await loadInDefaultList(uid));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'create_reminder',
    {
      description:
        'Create a new reminder in the configured default list. Returns the created reminder including its uid.',
      inputSchema: {
        name: z.string().describe('Name of the reminder'),
        body: z.string().optional().describe('Notes/body text for the reminder'),
        due_date: dueDateArg.optional(),
        start_date: startDateArg.optional(),
        priority: z.number().optional().describe('Priority: 0 (none), 1 (high), 5 (medium), 9 (low)'),
        url: urlArg.optional(),
        alerts: z.array(alertSchema).optional().describe('Alerts to fire for this reminder'),
        recurrence: recurrenceSchema.optional().describe('Repeat rule'),
      },
    },
    async ({ name, body, due_date, start_date, priority, url, alerts, recurrence }) => {
      try {
        return textResult(
          await remindersEk.createReminder(defaultList(), name, {
            body: joinNotes(body, url) ?? undefined,
            dueDate: due_date,
            startDate: start_date,
            priority,
            url: url === undefined ? undefined : normalizeLink(url),
            alerts,
            recurrence,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update_reminder',
    {
      description: "Update an existing reminder's details by uid. Pass null to clear a field.",
      inputSchema: {
        uid: z.string().describe('Reminder uid (EventKit calendarItemIdentifier)'),
        name: z.string().optional().describe('New name for the reminder'),
        body: z
          .string()
          .nullable()
          .optional()
          .describe('New notes/body text (null to clear); an attached url stays appended'),
        due_date: dueDateArg.nullable().optional(),
        start_date: startDateArg.nullable().optional(),
        priority: z.number().optional().describe('New priority: 0 (none), 1 (high), 5 (medium), 9 (low)'),
        url: urlArg
          .nullable()
          .optional()
          .describe('Link (absolute URL) appended to the notes; replaces the previous link, null removes it'),
        alerts: z.array(alertSchema).nullable().optional().describe('Replaces every existing alert'),
        recurrence: recurrenceSchema.nullable().optional().describe('Replaces the existing repeat rule'),
      },
    },
    async ({ uid, name, body, due_date, start_date, priority, url, alerts, recurrence }) => {
      try {
        const existing = await loadInDefaultList(uid);
        return textResult(
          await remindersEk.updateReminder(uid, {
            name,
            body: updatedNotes({ notes: existing.body, url: existing.url }, { body, url }),
            dueDate: due_date,
            startDate: start_date,
            priority,
            url: url === undefined || url === null ? url : normalizeLink(url),
            alerts,
            recurrence,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'complete_reminder',
    {
      description: 'Mark a reminder as completed by uid',
      inputSchema: {
        uid: z.string().describe('Reminder uid (EventKit calendarItemIdentifier)'),
      },
    },
    async ({ uid }) => {
      try {
        await loadInDefaultList(uid);
        return textResult(await remindersEk.completeReminder(uid));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'uncomplete_reminder',
    {
      description: 'Mark a completed reminder as incomplete by uid',
      inputSchema: {
        uid: z.string().describe('Reminder uid (EventKit calendarItemIdentifier)'),
      },
    },
    async ({ uid }) => {
      try {
        await loadInDefaultList(uid);
        return textResult(await remindersEk.uncompleteReminder(uid));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'delete_reminder',
      {
        description: 'Delete a reminder by uid',
        inputSchema: {
          uid: z.string().describe('Reminder uid (EventKit calendarItemIdentifier)'),
          confirm: confirmArg,
        },
      },
      async ({ uid, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the reminder. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          await loadInDefaultList(uid);
          return textResult(await remindersEk.deleteReminder(uid));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  server.registerTool(
    'search_reminders',
    {
      description: 'Search reminders by name in the configured default list',
      inputSchema: {
        query: z.string().describe('Text to search for in reminder names'),
        limit: limitArg,
      },
    },
    async ({ query, limit }) => {
      try {
        return textResult(await remindersEk.searchReminders(query, defaultList(), limit ?? DEFAULT_LIST_LIMIT));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
