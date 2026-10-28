/**
 * Step: bind-telegram — wait for the configured owner to message the bot, and report the chat.
 *
 * Replaces `pair-telegram`, which issued a 4-digit code and waited for it to come back. The code
 * existed to prove that the person completing setup controlled the Telegram account being registered,
 * because nothing else did: privilege went to whoever paired first. The roster answers that instead —
 * only the handle written into `config/local.jsonc` can become the owner — so what is left to do is
 * learn the numeric chat id, which a bot cannot know until the person messages it.
 *
 * That waiting is unavoidable on Telegram: bots cannot open a conversation. So this step waits, and
 * fails closed — a stranger poking the bot during setup does not match the configured handle and does
 * not bind.
 *
 * Emits machine-readable status blocks only; `setup:auto` renders the UI.
 *
 *   BIND_TELEGRAM_WAITING  { HANDLE, OWNER_KEY }
 *   BIND_TELEGRAM (final)  { STATUS=success, PLATFORM_ID, PAIRED_USER_ID, HANDLE }
 *                       or { STATUS=failed, ERROR }
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { initializeCentralSchema } from '../src/db/initialize.js';
import { loadLunaConfig } from '../src/config/loader.js';
import { ownerKey, rosterUser, validateRoster } from '../src/users/roster.js';
import { resolveUserKey } from '../src/users/binding.js';

import { emitStatus } from './status.js';

/** How long to wait for the owner's first message before giving up. */
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;

interface Bound {
  userId: string;
  platformId: string;
}

/**
 * A Telegram identity that resolves to the owner, plus the chat to reach them in.
 *
 * The DM's platform id is looked up rather than assumed: for Telegram it happens to equal the user id,
 * but reading the messaging group the host actually created keeps this correct if that stops being
 * true, and it also confirms the inbound message got as far as being routed.
 */
function findBoundOwner(owner: string): Bound | null {
  const rows = getDb().prepare("SELECT id FROM users WHERE kind = 'telegram' ORDER BY created_at DESC").all() as {
    id: string;
  }[];

  for (const row of rows) {
    if (resolveUserKey(row.id) !== owner) continue;
    const mg = getDb()
      .prepare("SELECT platform_id FROM messaging_groups WHERE channel_type = 'telegram' AND platform_id = ?")
      .get(row.id) as { platform_id: string } | undefined;
    return { userId: row.id, platformId: mg?.platform_id ?? row.id };
  }
  return null;
}

export async function run(args: string[]): Promise<void> {
  void args;

  const db = initDb(path.join(DATA_DIR, 'luna.db'));
  initializeCentralSchema(db);

  const owner = ownerKey(loadLunaConfig());
  if (!owner) {
    emitStatus('BIND_TELEGRAM', { STATUS: 'failed', ERROR: 'no-owner-configured' });
    process.exit(1);
  }

  const problems = validateRoster();
  if (problems.length > 0) {
    emitStatus('BIND_TELEGRAM', {
      STATUS: 'failed',
      ERROR: problems.map((p) => (p.key ? `${p.key}: ${p.message}` : p.message)).join('; '),
    });
    process.exit(1);
  }

  const handle = rosterUser(owner)?.telegramHandle;
  if (!handle) {
    emitStatus('BIND_TELEGRAM', { STATUS: 'failed', ERROR: 'owner-has-no-telegram-handle' });
    process.exit(1);
  }

  emitStatus('BIND_TELEGRAM_WAITING', { HANDLE: handle, OWNER_KEY: owner });

  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const bound = findBoundOwner(owner);
    if (bound) {
      emitStatus('BIND_TELEGRAM', {
        STATUS: 'success',
        PLATFORM_ID: bound.platformId,
        PAIRED_USER_ID: bound.userId,
        HANDLE: handle,
      });
      return;
    }
    if (Date.now() >= deadline) {
      emitStatus('BIND_TELEGRAM', { STATUS: 'failed', ERROR: 'timed-out-waiting-for-first-message' });
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
