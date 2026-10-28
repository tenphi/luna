import type { Mailbox } from '../types.js';
import { gmailExclusions } from '../exclusions.js';
import { withMailbox } from './client.js';
import { buildGmailQuery } from './search.js';

/** Operator-only count preview: no envelopes, message bodies or cached content are returned. */
export async function previewMailExclusions(mailbox: Mailbox, since: string, until: string) {
  const query = buildGmailQuery({ mailbox: mailbox.key, since, until, limit: 1 });
  return withMailbox(mailbox, async ({ client }) => {
    const all = await client.search({ gmraw: query }, { uid: true });
    const scoped = await client.search({ gmraw: `${query} ${gmailExclusions(mailbox)}`.trim() }, { uid: true });
    const total = all ? all.length : 0;
    const included = scoped ? scoped.length : 0;
    return {
      mailbox: mailbox.key,
      since,
      until,
      matchedMessages: total,
      includedMessages: included,
      excludedMessages: total - included,
      ignoreLabels: mailbox.ignoreLabels ?? [],
      ignoreSenders: mailbox.ignoreSenders ?? [],
    };
  });
}
