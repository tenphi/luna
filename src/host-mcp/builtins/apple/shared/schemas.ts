/**
 * Input schemas shared by the Apple calendar and reminders MCP servers.
 * Both write EventKit recurrence rules, and a rule means the same thing in either.
 */
import * as z from 'zod';

export const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).default(1),
  daysOfWeek: z
    .array(z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']))
    .optional()
    .describe('For weekly recurrence, which weekdays'),
  endDate: z.string().optional().describe('Stop recurring after this date'),
  occurrenceCount: z.number().int().min(1).optional().describe('Stop after N occurrences'),
});
