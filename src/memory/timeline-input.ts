import * as z from 'zod';
import type { TimelineInput } from '@tenphi/akno-client';

/** The released read contract, shared by the agent tool and the host command. */
export const timelineInput = z.object({
  timeline: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      'Ledger slug or Markdown path from list kind=timelines. Omit for the root timeline; * explicitly combines all',
    ),
  since: z.string().optional().describe('Inclusive date prefix: YYYY, YYYY-MM or YYYY-MM-DD'),
  until: z.string().optional().describe('Inclusive date prefix: YYYY, YYYY-MM or YYYY-MM-DD'),
  match: z.string().optional().describe('Text to match within the selected timeline'),
  subject: z.string().optional().describe('Page slug, retained subject id or document id/path'),
  source: z.enum(['all', 'both', 'event', 'state', 'plan', 'deadline', 'document', 'document_evidence']).optional(),
  scope: z.enum(['past', 'today', 'future', 'all']).optional(),
  clock_relation: z.enum(['past', 'today', 'current_period', 'ongoing', 'future', 'overdue', 'undated']).optional(),
  temporal_status: z.enum(['actual', 'scheduled', 'planned', 'tentative']).optional(),
  disposition: z
    .enum(['active', 'proposed', 'accepted', 'rejected', 'resolved', 'cancelled', 'completed', 'superseded'])
    .optional(),
  view: z.enum(['history', 'actionable']).optional(),
  as_of: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().optional(),
  limit: z.number().int().positive().max(2000).optional(),
  order: z.enum(['newest', 'oldest', 'nearest']).optional(),
}) satisfies z.ZodType<TimelineInput>;
