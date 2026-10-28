import { registerResource } from '../crud.js';
import { retryRead, withMemory } from '../../memory/client.js';
import { timelineInput } from '../../memory/timeline-input.js';

/**
 * Answering memory's gated proposals, from the owner's side.
 *
 * Memory refuses to guess where a claim goes when nothing scores high enough and it cannot name a
 * page for it either. That comes back as `requires_approval` with the content held — and until this
 * existed there was **no way to answer it**: `approve` is deliberately not an op, so it is absent
 * from the agent's tool surface, and the agent was left telling the owner something "needs your
 * approval" while offering no means to give it.
 *
 * A new folder is no longer one of these. The agent declares folders itself, ungated, saying what
 * belongs in each — so everything waiting here is a question about *where a claim goes*.
 *
 * A route proposal is not a yes/no. It exists precisely because no page was obviously right, so
 * approving it means *naming the page* — including one that does not exist yet, which is frequently
 * the correct answer. `pending` lists the candidates memory thought were closest; every one of them
 * is a page that could actually receive the write.
 */
registerResource({
  name: 'memory-proposal',
  plural: 'memory',
  table: 'install_settings',
  description:
    'Memory proposals waiting on the owner: a claim memory kept but would not file without being told which page it goes on.',
  idColumn: 'id',
  columns: [{ name: 'id', type: 'number', description: 'Always 1.', generated: true }],
  operations: {},
  customOperations: {
    timelines: {
      access: 'open',
      description: 'Discover timeline declarations, including empty files, with status and writability.',
      handler: async () => retryRead((client) => client.list({ kind: 'timelines' })),
    },
    timeline: {
      access: 'open',
      description:
        'Read one timeline: --timeline <ledger-slug|*> --since <date> --until <date> --match <text> --limit <count>. Omit --timeline for root only. Also supports --subject, --source, --scope, --view, --order, --as-of, --timezone, --clock-relation and --temporal-status. Results preserve temporal qualifications and membership.',
      handler: async (args) => {
        const input = timelineInput.parse({
          ...args,
          limit: args.limit === undefined ? 40 : Number(args.limit),
          as_of: args['as-of'] ?? args.as_of,
          clock_relation: args['clock-relation'] ?? args.clock_relation,
          temporal_status: args['temporal-status'] ?? args.temporal_status,
        });
        return retryRead((client) => client.timeline(input));
      },
    },
    pending: {
      access: 'open',
      description: 'List memory proposals waiting for an answer, with the pages each could go to.',
      handler: async () => {
        const proposals = (await retryRead((client) => client.command('proposals'))) as {
          id: string;
          kind: string;
          reason: string;
          subject: string;
          nearest: string;
        }[];
        return {
          waiting: proposals.length,
          proposals: proposals.map((proposal) => ({
            id: proposal.id,
            kind: proposal.kind,
            subject: proposal.subject,
            reason: proposal.reason,
            // Stored as JSON on the proposal; unwrapped here so the listing is readable.
            could_go_to: parseNearest(proposal.nearest),
          })),
          help: 'luna memory approve <id> --slug <page>   ·   luna memory decline <id>',
        };
      },
    },
    approve: {
      access: 'approval',
      description:
        'Answer a memory proposal. `--slug <page>` says where the held claim goes — required for a routing proposal, and naming a page that does not exist creates it.',
      handler: async (args) => {
        // The dispatcher moves a trailing positional into `args.id`, so both
        // `luna memory approve prop_x` and `--id prop_x` arrive here the same way.
        const id = String((args as Record<string, unknown>).id ?? '').trim();
        if (!id) throw new Error('Pass the proposal id: luna memory approve <id> --slug <page>');
        const slugRaw = (args as Record<string, unknown>).slug;
        const slug = typeof slugRaw === 'string' ? slugRaw.trim() : '';

        return withMemory((client) =>
          client.command('approve', { proposal_id: id, ...(slug ? { slug } : {}) }),
        ) as Promise<unknown>;
      },
    },
    decline: {
      access: 'approval',
      description:
        'Refuse a memory proposal. Remembered, so an agent asking for the same thing gets the refusal rather than asking again.',
      handler: async (args) => {
        const id = String((args as Record<string, unknown>).id ?? '').trim();
        if (!id) throw new Error('Pass the proposal id: luna memory decline <id>');
        return withMemory((client) => client.command('decline', { proposal_id: id })) as Promise<unknown>;
      },
    },
  },
});

function parseNearest(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
