/**
 * In-process Apple Calendar MCP server (EventKit, default-calendar only).
 *
 * Reads and uid-based writes go through EventKit via the vendored
 * `calendar-helper` Swift binary. Always scoped to config.defaultCalendar.
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-calendar-mcp` 1.0.0),
 * vendored in-tree by Luna. Raw tool names preserved for the tool-alias map.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import { errorResult, textResult } from '../../shared/cli.js';
import { assertEventInDefaultCalendar, requireDefault } from '../shared/defaults.js';
import * as eventkit from '../shared/eventkit.js';
import { joinNotes, normalizeLink, updatedNotes } from '../shared/notes-link.js';
import { confirmArg, confirmGuard, isReadOnly } from '../shared/safety.js';
import { linkSchema, recurrenceSchema } from '../shared/schemas.js';
import type { AppleAppConfig } from '../shared/types.js';

const alertSchema = z.object({
  offsetMinutes: z.number().describe('Minutes before the event to alert (relative only; e.g. 15)'),
});

const urlArg = linkSchema.describe(
  'Link (absolute URL). Stored as the event URL and appended to the description, since some calendars and apps never show the URL field — do not also paste it into description',
);

const timezoneArg = z
  .string()
  .optional()
  .describe(
    'IANA timezone for naive start/end wall-clock (default: install timezone from context). Omit for normal local times. Other-city meeting: "America/New_York". Flights: "Asia/Tokyo,America/Los_Angeles" (departure,arrival). Do not use with all_day.',
  );

export function createCalendarMcpServer(config: AppleAppConfig): McpServer {
  const mode = config.safetyMode;
  const server = new McpServer({ name: 'apple-calendar', version: '1.0.0' }, { capabilities: {} });

  function defaultCalendar(): string {
    return requireDefault(config.defaultCalendar, 'calendar');
  }

  async function loadInDefaultCalendar(uid: string): Promise<eventkit.CalendarEvent> {
    const calendar = defaultCalendar();
    const event = await eventkit.getEvent(uid);
    assertEventInDefaultCalendar(event, calendar);
    return event;
  }

  async function readBack(
    written: eventkit.CalendarEvent,
    expected: Partial<Pick<eventkit.CalendarEvent, 'summary' | 'location' | 'description' | 'url'>>,
  ): Promise<
    eventkit.CalendarEvent & {
      verification: { status: 'confirmed' | 'mismatch' | 'unavailable'; fields?: string[]; reason?: string };
    }
  > {
    try {
      const saved = await loadInDefaultCalendar(written.uid);
      const fields = (Object.keys(expected) as Array<keyof typeof expected>).filter(
        (key) => expected[key] !== undefined && saved[key] !== expected[key],
      );
      return { ...saved, verification: fields.length ? { status: 'mismatch', fields } : { status: 'confirmed' } };
      // eslint-disable-next-line no-catch-all/no-catch-all -- verification failure must not turn a completed write into a retry
    } catch (err) {
      // The write may have succeeded even when EventKit readback is unavailable. Preserve the
      // returned uid so the agent can check it later without creating a duplicate event.
      return {
        ...written,
        verification: { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  server.registerTool(
    'list_events',
    {
      description:
        'List events in the configured default calendar within a date range. Each event includes a stable uid for get/update/delete. Times are shown in the install timezone; timeZone is the pinned event zone when set.',
      inputSchema: {
        from_date: z.string().describe("Start date (e.g. '1 January 2025' or '2031-05-14T00:00:00')"),
        to_date: z.string().describe("End date (e.g. '31 January 2025' or '2031-05-14T23:59:59')"),
      },
    },
    async ({ from_date, to_date }) => {
      try {
        return textResult(await eventkit.listEvents(defaultCalendar(), from_date, to_date));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_event',
    {
      description: 'Get full details of an event by its uid (from list/search/create or the session agenda)',
      inputSchema: {
        uid: z.string().describe('Event uid (EventKit eventIdentifier)'),
      },
    },
    async ({ uid }) => {
      try {
        return textResult(await loadInDefaultCalendar(uid));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'create_event',
    {
      description:
        'Create a new event in the configured default calendar. If a field comes from a document, read its exact text before using it; omit missing locations rather than guessing. Returns the created event including its uid and fields for verification. Prefer naive local wall-clock times without timezone; pass timezone only for other-city times or flights.',
      inputSchema: {
        summary: z.string().describe('Title/summary of the event'),
        start_date: z.string().describe("Start date and time as local wall-clock (prefer '2031-05-14T14:00')"),
        end_date: z.string().describe("End date and time as local wall-clock (prefer '2031-05-14T15:00')"),
        location: z.string().optional().describe('Location of the event'),
        description: z.string().optional().describe('Description or notes for the event'),
        all_day: z.boolean().optional().describe('Whether this is an all-day event'),
        timezone: timezoneArg,
        url: urlArg.optional(),
        alerts: z.array(alertSchema).optional().describe('Relative alerts before the event'),
        recurrence: recurrenceSchema.optional().describe('Recurrence rule for a repeating event'),
      },
    },
    async ({ summary, start_date, end_date, location, description, all_day, timezone, url, alerts, recurrence }) => {
      try {
        const notes = joinNotes(description, url) ?? undefined;
        const link = url === undefined ? undefined : normalizeLink(url);
        const created = await eventkit.createEvent(defaultCalendar(), summary, start_date, end_date, {
          location,
          description: notes,
          allDay: all_day,
          timezone,
          url: link,
          alerts,
          recurrence,
        });
        return textResult(
          await readBack(created, { summary, location: location ?? null, description: notes, url: link }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update_event',
    {
      description:
        'Update an existing calendar event by uid. Read the target event first, pass only fields the user asked to change or the exact source supports, and verify the returned fields. Changing recurrence applies to this and future occurrences.',
      inputSchema: {
        uid: z.string().describe('Event uid (EventKit eventIdentifier)'),
        summary: z.string().optional().describe('New title/summary for the event'),
        start_date: z
          .string()
          .optional()
          .describe("New start date and time as local wall-clock (prefer '2031-05-14T14:00')"),
        end_date: z
          .string()
          .optional()
          .describe("New end date and time as local wall-clock (prefer '2031-05-14T15:00')"),
        location: z.string().nullable().optional().describe('New location (null to clear)'),
        description: z
          .string()
          .nullable()
          .optional()
          .describe('New description or notes (null to clear); an attached url stays appended'),
        all_day: z.boolean().optional().describe('Whether this is an all-day event'),
        timezone: timezoneArg,
        url: urlArg
          .nullable()
          .optional()
          .describe(
            'Link (absolute URL), stored as the event URL and appended to the description; replaces the previous link, null removes it',
          ),
        alerts: z.array(alertSchema).nullable().optional().describe('Replace relative alerts (null or [] to clear)'),
        recurrence: recurrenceSchema
          .nullable()
          .optional()
          .describe('Set or clear (null) the recurrence rule; applies to future occurrences'),
      },
    },
    async ({
      uid,
      summary,
      start_date,
      end_date,
      location,
      description,
      all_day,
      timezone,
      url,
      alerts,
      recurrence,
    }) => {
      try {
        const existing = await loadInDefaultCalendar(uid);
        const notes = updatedNotes({ notes: existing.description, url: existing.url }, { body: description, url });
        const link = url === undefined || url === null ? url : normalizeLink(url);
        const updated = await eventkit.updateEvent(uid, {
          summary,
          startDate: start_date,
          endDate: end_date,
          location,
          description: notes,
          allDay: all_day,
          timezone,
          fallbackTimezone: existing.timeZone,
          existingStartDate: existing.startDate,
          existingEndDate: existing.endDate,
          url: link,
          alerts: alerts === null ? null : alerts === undefined ? undefined : alerts.length === 0 ? null : alerts,
          recurrence,
        });
        return textResult(await readBack(updated, { summary, location, description: notes, url: link }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'delete_event',
      {
        description: 'Delete an event by its uid (from list/search/create or the session agenda)',
        inputSchema: {
          uid: z.string().describe('Event uid (EventKit eventIdentifier)'),
          confirm: confirmArg,
        },
      },
      async ({ uid, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the calendar event. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          await loadInDefaultCalendar(uid);
          return textResult(await eventkit.deleteEvent(uid));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  server.registerTool(
    'search_events',
    {
      description:
        'Search events by summary/title in the configured default calendar. Each result includes a stable uid for get/update/delete.',
      inputSchema: {
        query: z.string().describe('Text to search for in event summaries'),
      },
    },
    async ({ query }) => {
      try {
        return textResult(await eventkit.searchEvents(query, defaultCalendar()));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
