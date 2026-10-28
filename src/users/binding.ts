/**
 * Binding a channel identity to a configured person, and answering "is this the owner?".
 *
 * The split from `./roster.ts` is deliberate: that module is pure config, this one is the half that
 * needs the `users` table. Config says *who exists* and carries the handle; the platform supplies the
 * numeric id. Neither alone can resolve an inbound message, so this is where they meet.
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { CLI_LOCAL_USER_ID } from '../platform-id.js';
import type { User } from '../types.js';
import { matchRosterByIdentity, ownerKey, rosterUser } from './roster.js';

/** The channel part of a namespaced user id: `telegram:1000000001` → `telegram`. */
function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

function readUser(userId: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
}

/** Does some other identity on this channel already hold this person's key? */
function keyHeldOnChannel(key: string, kind: string, exceptUserId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE user_key = ? AND kind = ? AND id <> ? LIMIT 1')
    .get(key, kind, exceptUserId) as { id: string } | undefined;
  return row?.id;
}

/** Record that `userId` is the configured person `key`. */
export function bindUserKey(userId: string, key: string): void {
  getDb().prepare('UPDATE users SET user_key = ? WHERE id = ?').run(key, userId);
}

/**
 * Which configured person this identity is, or null if the roster does not claim it.
 *
 * Order matters:
 *   1. `cli:local` is the owner. Attribution only — its *privilege* is unconditional (see
 *      `isOwner`), so a roster that names nobody still leaves the terminal working.
 *   2. A stored `user_key`, when it still names someone in config. Removing a person from config
 *      immediately stops resolving their old rows, without needing to clean the table.
 *   3. Otherwise match the platform handle and, on a hit, record the binding.
 *
 * Step 3 is first-binding-wins per channel: if another identity on the same channel already holds
 * that key, this one is refused rather than silently becoming a second Telegram account for the same
 * person. Telegram handles are recyclable and `upsertUser` never clears `platform_username`, so
 * without that rule a released handle would hand a stranger someone else's config entry.
 */
export function resolveUserKey(userId: string): string | null {
  if (userId === CLI_LOCAL_USER_ID) return ownerKey();

  const user = readUser(userId);
  if (!user) return null;

  if (user.user_key && rosterUser(user.user_key)) return user.user_key;

  const match = matchRosterByIdentity(user.kind || channelTypeOf(userId), {
    username: user.platform_username ?? null,
  });
  if (!match) return null;

  const holder = keyHeldOnChannel(match.key, user.kind, userId);
  if (holder) {
    log.warn('Roster handle match refused — another identity on this channel already holds the key', {
      userId,
      key: match.key,
      heldBy: holder,
    });
    return null;
  }

  bindUserKey(userId, match.key);
  log.info('Bound channel identity to configured user', { userId, key: match.key });
  return match.key;
}

/**
 * Is this identity the install owner?
 *
 * The local CLI identity always is, without a grant and without appearing in the roster. Reaching
 * `data/cli.sock` requires host access — the socket is 0600 — so the privilege is already held by
 * anyone able to ask. Keeping it independent of config is what makes the terminal a usable recovery
 * path when the roster is the thing that is wrong.
 */
export function isOwner(userId: string): boolean {
  if (userId === CLI_LOCAL_USER_ID) return true;
  const owner = ownerKey();
  if (!owner) return false;
  return resolveUserKey(userId) === owner;
}

/**
 * The owner's channel identities, newest first, for delivering something to them.
 *
 * Config establishes who the owner *is*; only a `users` row makes them reachable. An owner who has
 * never sent a message has no row, so this is empty and callers must cope — `pickApprover` appends
 * `cli:local` for exactly that case.
 */
export function ownerIdentities(): string[] {
  const owner = ownerKey();
  if (!owner) return [];

  // Resolved per row rather than filtered on the stored `user_key`, because a row can exist without
  // ever having been bound: `resolveUserKey` binds on the *inbound* path, and `init-first-agent`
  // creates the owner's row on the *setup* path. Filtering on the column alone made a freshly set-up
  // owner unreachable — no approval card could be delivered to them until they happened to send a
  // message. Going through the resolver also binds as it goes, so the two paths converge.
  //
  // `cli:local` is excluded here and appended by `pickApprover` instead, so it stays last.
  const rows = getDb()
    .prepare('SELECT id FROM users WHERE id <> ? ORDER BY created_at DESC')
    .all(CLI_LOCAL_USER_ID) as { id: string }[];
  return rows.filter((r) => resolveUserKey(r.id) === owner).map((r) => r.id);
}

/**
 * The per-person hot-memory page for this identity, or null when it resolves to nobody.
 *
 * Named for the config key, never for a platform handle. That is the point of the key existing: a
 * Telegram handle can be changed or released, and a memory page named after one is orphaned when it
 * is. Someone the roster does not claim has no page — there is nobody to have notes about.
 */
export function hotMemorySlugFor(userId: string): string | null {
  const key = resolveUserKey(userId);
  return key ? `users/${key}` : null;
}
