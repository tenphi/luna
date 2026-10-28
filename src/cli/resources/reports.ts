import { registerResource } from '../crud.js';
import { countOpenReports, listReports, resolveReport } from '../../db/reports.js';

/**
 * Working through what `/report` collected.
 *
 * One complaint is an anecdote; five naming the same behaviour is a bug with a reproduction. So the
 * listing is ordered for triage — open first, newest first — and each row carries the exchange that
 * prompted it, captured when the report was filed because the session it came from will be
 * garbage-collected long before anyone gets round to it.
 */
registerResource({
  name: 'report',
  plural: 'reports',
  table: 'reports',
  description: 'Sessions the owner flagged with `/report`, with the complaint and the exchange that prompted it.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Report id, quoted back in chat when it is filed.' },
    { name: 'created_at', type: 'string', description: 'When it was filed. Auto-set.' },
    { name: 'session_id', type: 'string', description: 'Session it came from — may no longer exist.' },
    { name: 'agent_group_id', type: 'string', description: 'Agent group that was misbehaving.' },
    { name: 'messaging_group_id', type: 'string', description: 'Chat it was filed from.' },
    { name: 'user_id', type: 'string', description: 'Who filed it.' },
    { name: 'complaint', type: 'string', description: 'What the owner said went wrong.' },
    { name: 'context', type: 'string', description: 'Last few messages, captured at report time.' },
    { name: 'status', type: 'string', description: '`open` or `resolved`.' },
    { name: 'resolved_at', type: 'string', description: 'When it was closed.' },
    { name: 'resolution', type: 'string', description: 'What was done about it.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List reports, open first and newest first. `--status open|resolved` to filter.',
      handler: async (args) => {
        const status = (args as Record<string, unknown>).status;
        const limitRaw = (args as Record<string, unknown>).limit;
        const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 50;
        const rows = listReports(
          typeof status === 'string' && status ? status : undefined,
          Number.isFinite(limit) && limit > 0 ? limit : 50,
        );
        return {
          open: countOpenReports(),
          total: rows.length,
          reports: rows.map((row) => ({
            id: row.id,
            at: row.created_at,
            status: row.status,
            complaint: row.complaint,
            agent_group_id: row.agent_group_id,
            session_id: row.session_id,
            // The transcript slice is long; the listing shows enough to recognise it.
            context: row.context ? `${row.context.slice(0, 400)}${row.context.length > 400 ? '…' : ''}` : null,
            resolution: row.resolution,
          })),
        };
      },
    },
    resolve: {
      access: 'approval',
      description: 'Close a report: `luna reports resolve <id> --resolution "what was done"`.',
      handler: async (args) => {
        const record = args as Record<string, unknown>;
        const id = String(record.id ?? '').trim();
        if (!id) throw new Error('Pass the report id: luna reports resolve <id> --resolution "…"');
        const resolution = typeof record.resolution === 'string' ? record.resolution.trim() : '';
        const updated = resolveReport(id, resolution || null);
        if (!updated) throw new Error(`No report with id ${id}`);
        return { id: updated.id, status: updated.status, resolution: updated.resolution };
      },
    },
  },
});
