/**
 * The roster: turning `config.users` into people, and an inbound identity into one of them.
 *
 * Everything about *who* Luna talks to resolves through here. The config is the source of truth; the
 * `users` table is a cache of which channel identities have been seen and which person each one
 * turned out to be.
 *
 * This module is deliberately free of database access. Config-only resolution is what setup, the CLI
 * and validation need, and keeping it pure means the roster can be checked before a database exists —
 * which matters because `validateRoster` runs at host start, in `luna health`, and in setup. The
 * identity binding that does need the `users` table lives in `./binding.ts`.
 */
import { loadLunaConfig } from '../config/loader.js';
import type { LunaConfigDoc, UserConfigDoc } from '../config/schema.js';

/** Reserved: `users/shared` is the everyone-page, so no person may claim that slug. */
const RESERVED_KEYS = new Set(['shared']);

/** A config user with everything defaulted and normalized. */
export interface RosterUser {
  /** The config key. Also the person's identity everywhere in the install. */
  key: string;
  /** Resolved display name: config `name`, else the key. Platform names fill in at bind time. */
  name: string;
  /** Lowercased, `@`-stripped Telegram handle, or null. */
  telegramHandle: string | null;
  memoryPage: string | null;
  enabled: boolean;
  /** `users/<key>` — the per-person page injected every turn. */
  hotMemorySlug: string;
}

export interface RosterError {
  /** The config key at fault, or null for a whole-roster problem. */
  key: string | null;
  message: string;
}

/**
 * Reduce a handle to a comparable form: no leading `@`, lowercase.
 *
 * Only these two steps. An earlier normalizer also collapsed punctuation to hyphens, which is right
 * for building a slug and wrong for comparing handles — Telegram usernames may contain `_`, and
 * rewriting it made `bo_luna` fail to match itself.
 */
export function normalizeTelegramHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  return cleaned ? cleaned : null;
}

function toRosterUser(key: string, doc: UserConfigDoc | undefined): RosterUser {
  const name = doc?.name?.trim();
  const memoryPage = doc?.memoryPage?.trim();
  return {
    key,
    name: name || key,
    telegramHandle: normalizeTelegramHandle(doc?.telegramHandle),
    memoryPage: memoryPage || null,
    enabled: doc?.enabled !== false,
    hotMemorySlug: `users/${key}`,
  };
}

/** Every configured person, in config order. */
export function configUsers(cfg: LunaConfigDoc = loadLunaConfig()): RosterUser[] {
  return Object.entries(cfg.users ?? {})
    .filter(([, doc]) => doc !== null && doc !== undefined)
    .map(([key, doc]) => toRosterUser(key, doc));
}

/** One configured person by key, or undefined. */
export function rosterUser(
  key: string | null | undefined,
  cfg: LunaConfigDoc = loadLunaConfig(),
): RosterUser | undefined {
  if (!key) return undefined;
  const doc = cfg.users?.[key];
  return doc ? toRosterUser(key, doc) : undefined;
}

/** The configured owner's key, or null when unset. */
export function ownerKey(cfg: LunaConfigDoc = loadLunaConfig()): string | null {
  const raw = cfg.owner?.trim();
  return raw ? raw : null;
}

/**
 * Which configured person a channel identity belongs to, by what the platform told us.
 *
 * Handles only — the numeric id is matched by the binding layer, which has the stored `user_key` to
 * consult. Disabled users still match: "we know who this is and are refusing them" and "we have no
 * idea who this is" are different answers, and the gate needs to tell them apart.
 */
export function matchRosterByIdentity(
  channelType: string,
  identity: { username?: string | null },
  cfg: LunaConfigDoc = loadLunaConfig(),
): RosterUser | undefined {
  if (channelType !== 'telegram') return undefined;
  const handle = normalizeTelegramHandle(identity.username);
  if (!handle) return undefined;
  return configUsers(cfg).find((u) => u.telegramHandle === handle);
}

/**
 * Everything wrong with the roster as written.
 *
 * This is the one config section where a typo is a security outcome rather than a failed call: an
 * owner naming a key that does not exist leaves the install with no owner, and a duplicate handle
 * makes which person an inbound message resolves to depend on object key order. Both are quiet
 * unless something says so, hence this.
 */
export function validateRoster(cfg: LunaConfigDoc = loadLunaConfig()): RosterError[] {
  const errors: RosterError[] = [];
  const entries = Object.entries(cfg.users ?? {});
  const users = configUsers(cfg);

  for (const [key, doc] of entries) {
    if (doc === null || doc === undefined) continue;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      errors.push({
        key,
        message:
          'key must be lowercase letters, digits, "-" or "_", starting with a letter or digit — it is used as a memory page name',
      });
    }
    if (key.includes(':')) {
      errors.push({ key, message: 'key may not contain ":" — that separates a channel from a handle in user ids' });
    }
    if (RESERVED_KEYS.has(key)) {
      errors.push({ key, message: `"${key}" is reserved — users/${key} is the shared page, not a person` });
    }
    const page = doc.memoryPage?.trim();
    if (page && (page.startsWith('/') || /\.mdx?$/i.test(page))) {
      errors.push({ key, message: 'memoryPage must be a slug like "people/jane-doe" — no leading "/" and no ".md"' });
    }
  }

  const byHandle = new Map<string, string[]>();
  for (const user of users) {
    if (!user.telegramHandle) continue;
    const holders = byHandle.get(user.telegramHandle) ?? [];
    holders.push(user.key);
    byHandle.set(user.telegramHandle, holders);
  }
  for (const [handle, holders] of byHandle) {
    if (holders.length > 1) {
      errors.push({
        key: null,
        message: `telegramHandle "${handle}" is claimed by more than one user (${holders.join(', ')}) — an inbound message could not be attributed`,
      });
    }
  }

  const owner = ownerKey(cfg);
  if (!owner) {
    // Not an error on a bare install with no roster at all — that is a valid pre-setup state, and
    // the host terminal is still privileged. It is an error the moment anyone is configured.
    if (users.length > 0) {
      errors.push({ key: null, message: 'owner is not set — name one of the users keys as "owner"' });
    }
  } else if (!users.some((u) => u.key === owner)) {
    errors.push({ key: null, message: `owner "${owner}" is not a key under users` });
  } else if (!rosterUser(owner, cfg)?.enabled) {
    errors.push({ key: null, message: `owner "${owner}" is disabled — an install cannot have a disabled owner` });
  }

  return errors;
}
