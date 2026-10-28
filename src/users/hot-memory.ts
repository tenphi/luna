/**
 * Making sure every configured person has a page to have notes on.
 *
 * `users/<key>` is the one page injected into every turn that person speaks in. It is small by design —
 * a few standing lines — and everything durable about them belongs on their `memoryPage`, which this
 * links to rather than duplicates.
 *
 * Scaffolded rather than left to appear on demand, because the alternative is a prompt that references
 * a page the agent has never seen and cannot be asked to write to. Existing pages are never touched:
 * this creates, it does not reconcile.
 */
import { loadLunaConfig } from '../config/loader.js';
import { log } from '../log.js';
import { MemoryUnavailable, retryRead, withMemory } from '../memory/client.js';
import { configUsers, type RosterUser } from './roster.js';

/** The standing instruction each page carries, so the agent knows what it is for. */
function pageBody(user: RosterUser): string {
  const lines = [`# ${user.name}`, ''];
  if (user.memoryPage) {
    lines.push(`Full profile: [[${user.memoryPage}]]`, '');
  }
  lines.push(
    'Standing notes about this person, injected on every turn they speak in. Keep it short — a few',
    'lines that change how to talk to them, not a record of what they said.',
    '',
    user.memoryPage
      ? `Durable facts belong on [[${user.memoryPage}]], not here.`
      : 'Durable facts belong on their own page under `people/`, not here.',
  );
  return lines.join('\n');
}

async function pageExists(slug: string): Promise<boolean> {
  try {
    const raw: unknown = await retryRead((client) => client.call('read', { slug } as never));
    return typeof raw === 'string' ? raw.trim().length > 0 : raw != null;
  } catch (err) {
    // A missing page is the normal answer here and arrives as an error from some memory versions.
    // Treating "cannot tell" as "exists" is the safe way round: it declines to write rather than
    // risking an overwrite.
    if (err instanceof MemoryUnavailable) throw err;
    return false;
  }
}

/**
 * Create a `users/<key>` page for every enabled configured person that lacks one.
 *
 * Best-effort and non-fatal: memory being down must not stop the host from starting, and a page that
 * fails to appear costs a turn of context, not correctness. `actor: 'user'` because this is the
 * operator's own configuration taking effect, not an agent proposing something — memory's write gate
 * does not stand between an operator and their own roster.
 */
export async function ensureHotMemoryPages(): Promise<{ created: string[]; skipped: number }> {
  const users = configUsers(loadLunaConfig()).filter((u) => u.enabled);
  const created: string[] = [];
  let skipped = 0;

  for (const user of users) {
    try {
      if (await pageExists(user.hotMemorySlug)) {
        skipped++;
        continue;
      }
      await withMemory((client) =>
        client.call('write', {
          slug: user.hotMemorySlug,
          content: pageBody(user),
          actor: 'user',
        } as never),
      );
      created.push(user.hotMemorySlug);
    } catch (err) {
      if (err instanceof MemoryUnavailable) {
        log.info('Skipped hot-memory scaffolding — memory is not reachable', {
          pending: users.length - created.length,
        });
        return { created, skipped };
      }
      log.warn('Could not create a hot-memory page', { slug: user.hotMemorySlug, err });
    }
  }

  if (created.length > 0) log.info('Created hot-memory pages', { pages: created });
  return { created, skipped };
}
