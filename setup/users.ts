/**
 * Step: users — write the roster, i.e. who Luna will talk to and which of them owns the install.
 *
 * This replaces two runtime mechanisms with one setup question. Ownership used to go to whoever sent
 * the pairing code first, and everyone else was admitted by the owner tapping Allow on a card. Both
 * were decisions taken in a chat, which meant the answer to "who can talk to my assistant" lived in
 * three SQLite tables and not in the file the operator edits.
 *
 * The key each person gets is theirs to choose. It is the only name for that person in the install and
 * it names their hot-memory page (`users/<key>`), so it deliberately derives from nothing external — a
 * Telegram handle can change without orphaning a memory page.
 *
 * Non-interactive: `setup:auto` collects the answers with clack and passes them as flags, because that
 * is the only place a prompt can be rendered. Blocks emitted:
 *
 *   USERS (final)  { STATUS=success, OWNER_KEY, COUNT, HANDLES }
 *               or { STATUS=failed, ERROR }
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { initializeCentralSchema } from '../src/db/initialize.js';
import { clearConfigCache, loadLunaConfig } from '../src/config/loader.js';
import { persistRoster } from '../src/config/setup-persist.js';
import type { UserConfigDoc } from '../src/config/schema.js';
import { validateRoster } from '../src/users/roster.js';

import { emitStatus } from './status.js';

/**
 * `--user <key>:<name>:<handle>` — name and handle optional, so `--user ada` is valid.
 *
 * Split from both ends rather than left to right: the key and the handle cannot contain a colon (a key
 * is validated against `[a-z0-9_-]` and a Telegram handle against `[A-Za-z0-9_]`), but a *name* can —
 * "Jan: The Younger" would otherwise shift the rest of the string into the handle field and silently
 * configure an unmatchable person.
 */
function parseUserFlag(raw: string): { key: string; doc: UserConfigDoc } | null {
  const first = raw.indexOf(':');
  const key = (first === -1 ? raw : raw.slice(0, first)).trim();
  if (!key) return null;

  const doc: UserConfigDoc = {};
  if (first !== -1) {
    const rest = raw.slice(first + 1);
    const last = rest.lastIndexOf(':');
    const name = (last === -1 ? rest : rest.slice(0, last)).trim();
    const handle = last === -1 ? '' : rest.slice(last + 1).trim();
    if (name) doc.name = name;
    if (handle) doc.telegramHandle = handle.replace(/^@+/, '');
  }
  return { key, doc };
}

/**
 * A config key from a display name: lowercase, first word only.
 *
 * First word because the key is typed by hand later (`luna users bind --key …`) and read as a memory
 * page name; "ada" beats "ada-marlow" for both. Callers pass an explicit `--owner-key` when
 * they want something else.
 */
export function suggestUserKey(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')[0];
  return slug || 'owner';
}

export async function run(args: string[]): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'luna.db'));
  initializeCentralSchema(db);

  const flag = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx === -1 ? undefined : args[idx + 1];
  };

  const ownerName = flag('owner-name')?.trim();
  const ownerHandle = flag('owner-handle')?.trim().replace(/^@+/, '');
  const ownerKeyArg = flag('owner-key')?.trim();
  const ownerKey = ownerKeyArg || (ownerName ? suggestUserKey(ownerName) : '');

  if (!ownerKey) {
    emitStatus('USERS', { STATUS: 'failed', ERROR: 'pass --owner-key or --owner-name' });
    process.exit(1);
  }

  // Start from what is already configured so a re-run adds rather than replaces. Someone who set up
  // Telegram, skipped, and came back should not lose the people they already had.
  const existing = loadLunaConfig().users ?? {};
  const users: NonNullable<typeof existing> = { ...existing };

  users[ownerKey] = {
    ...users[ownerKey],
    ...(ownerName ? { name: ownerName } : {}),
    ...(ownerHandle ? { telegramHandle: ownerHandle } : {}),
  };

  // Repeatable `--user key:name:handle` for everyone else.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--user') continue;
    const parsed = parseUserFlag(args[i + 1] ?? '');
    if (!parsed) {
      emitStatus('USERS', { STATUS: 'failed', ERROR: `could not read --user "${args[i + 1] ?? ''}"` });
      process.exit(1);
    }
    users[parsed.key] = { ...users[parsed.key], ...parsed.doc };
  }

  persistRoster({ users, owner: ownerKey });
  clearConfigCache();

  // Validate what was actually written, not what we meant to write. A roster that cannot work is
  // worth failing setup over — this is the one step whose output decides whether anyone can talk to
  // the install at all.
  const problems = validateRoster();
  if (problems.length > 0) {
    emitStatus('USERS', {
      STATUS: 'failed',
      ERROR: problems.map((p) => (p.key ? `${p.key}: ${p.message}` : p.message)).join('; '),
    });
    process.exit(1);
  }

  const handles = Object.entries(users)
    .map(([key, doc]) => `${key}${doc?.telegramHandle ? `=@${doc.telegramHandle}` : ''}`)
    .join(',');
  emitStatus('USERS', {
    STATUS: 'success',
    OWNER_KEY: ownerKey,
    COUNT: String(Object.keys(users).length),
    HANDLES: handles,
  });
}
