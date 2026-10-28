/**
 * Which mailbox "mine" means, when the agent does not say.
 *
 * A shared assistant asked "did the invoice arrive?" should look in the mailbox of the person who
 * asked, not in whichever one happens to be first in config. The caller context carries a session
 * id, a session belongs to a messaging group, and a one-to-one messaging group belongs to exactly
 * one person — so the chain resolves for the case that matters, a DM.
 *
 * **This is a default, not a boundary.** There is one install-wide agent group, and the session id
 * arrives as a claim from the container rather than as something authenticated (see
 * `caller-context.ts`). Any session can therefore name any mailbox by passing `mailbox` explicitly,
 * and that is deliberate — the roster shares one assistant on purpose, and a search that could not
 * cross mailboxes could not answer "did *either* of us get it?". Nothing here should ever be cited
 * as isolation between the people in the roster; real isolation would need an agent group each.
 *
 * In a group chat, at the CLI, or on a scheduled run there is no single asker, so this returns null
 * and the tool asks for `mailbox` by name rather than guessing one.
 */
import { getDb } from '../../../../db/connection.js';
import { getMessagingGroup } from '../../../../db/messaging-groups.js';
import { getSession } from '../../../../db/sessions.js';
import { resolveUserKey } from '../../../../users/binding.js';
import type { HostMcpCaller } from '../../../caller-context.js';
import type { MailConfig } from './types.js';

/** Every user id that has this messaging group cached as their DM. */
function usersWithDm(messagingGroupId: string): string[] {
  const rows = getDb()
    .prepare('SELECT user_id FROM user_dms WHERE messaging_group_id = ?')
    .all(messagingGroupId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

/**
 * The roster key of the person this session is talking to, or null.
 *
 * Reads the database, so it is deliberately tolerant: a host running without a database, a session
 * id that names nothing, or a group chat all mean "no default", which is a fine answer. Only a
 * *confident* single-person resolution counts.
 */
export function callerUserKey(caller: HostMcpCaller | undefined): string | null {
  if (!caller?.sessionId) return null;

  try {
    const session = getSession(caller.sessionId);
    if (!session?.messaging_group_id) return null;

    const group = getMessagingGroup(session.messaging_group_id);
    // A group chat has no single asker. Guessing one there would put a partner's mail in front of
    // whoever spoke last, which is the one outcome nobody asked for.
    if (!group || group.is_group !== 0) return null;

    const keys = new Set(
      usersWithDm(group.id)
        .map((userId) => resolveUserKey(userId))
        .filter((key): key is string => Boolean(key)),
    );
    // Exactly one, or it is not a default. Two keys on one DM means the cache is stale or the
    // handle was recycled, and either way the honest answer is to ask.
    return keys.size === 1 ? [...keys][0]! : null;
  } catch {
    // No database, no schema yet, a session row mid-delete. None of these are worth failing a mail
    // search over — they all mean the same thing here, which is that there is no default to offer.
    return null;
  }
}

export interface MailboxChoice {
  /** Roster keys to search. Empty only when nothing is configured. */
  keys: string[];
  /** Set when no mailbox could be chosen — the message explains what to pass instead. */
  error?: string;
}

/**
 * Turn an optional `mailbox` argument into the mailboxes to actually search.
 *
 * `'*'` is every configured mailbox, which is what makes the unified view reachable on purpose
 * rather than by accident.
 */
export function chooseMailboxes(
  config: MailConfig,
  requested: string | undefined,
  caller: HostMcpCaller | undefined,
): MailboxChoice {
  const configured = config.mailboxes.map((m) => m.key);
  if (configured.length === 0) {
    const detail = config.problems.length > 0 ? ` (${config.problems.map((p) => p.message).join('; ')})` : '';
    return { keys: [], error: `No mailbox is configured${detail}.` };
  }

  if (requested === '*') return { keys: configured };

  if (requested) {
    if (!configured.includes(requested)) {
      return {
        keys: [],
        error: `No mailbox named ${JSON.stringify(requested)}. Configured: ${configured.join(', ')}, or "*" for all.`,
      };
    }
    return { keys: [requested] };
  }

  const own = callerUserKey(caller);
  if (own && configured.includes(own)) return { keys: [own] };

  if (configured.length === 1) return { keys: configured };

  return {
    keys: [],
    error:
      `Which mailbox? This conversation does not identify one person, so there is no default. ` +
      `Pass mailbox: ${configured.map((k) => JSON.stringify(k)).join(' | ')}, or "*" to search all of them.`,
  };
}
