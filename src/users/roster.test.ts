/**
 * Roster resolution and validation.
 *
 * These take an explicit config object rather than mocking the loader, because that is how the
 * production callers use them — the roster is a pure function of the merged document.
 */
import { describe, expect, it } from 'vitest';

import type { LunaConfigDoc } from '../config/schema.js';
import {
  configUsers,
  matchRosterByIdentity,
  normalizeTelegramHandle,
  ownerKey,
  rosterUser,
  validateRoster,
} from './roster.js';

const TWO_PEOPLE: LunaConfigDoc = {
  users: {
    ada: { name: 'Ada Marlow', telegramHandle: 'ada_marlow', memoryPage: 'people/ada-marlow' },
    bo: { name: 'bo', telegramHandle: 'bo_luna' },
  },
  owner: 'ada',
};

describe('normalizeTelegramHandle', () => {
  it('strips @ and lowercases', () => {
    expect(normalizeTelegramHandle('@ADA_MARLOW')).toBe('ada_marlow');
    expect(normalizeTelegramHandle('  @@ADA_MARLOW  ')).toBe('ada_marlow');
  });

  it('keeps underscores', () => {
    // The old normalizer collapsed punctuation to hyphens, which made bo_luna unmatchable.
    expect(normalizeTelegramHandle('bo_luna')).toBe('bo_luna');
  });

  it('is null for nothing', () => {
    expect(normalizeTelegramHandle(undefined)).toBeNull();
    expect(normalizeTelegramHandle('')).toBeNull();
    expect(normalizeTelegramHandle('@')).toBeNull();
  });
});

describe('configUsers', () => {
  it('defaults name to the key and enabled to true', () => {
    const users = configUsers({ users: { bob: {} } });
    expect(users).toEqual([
      { key: 'bob', name: 'bob', telegramHandle: null, memoryPage: null, enabled: true, hotMemorySlug: 'users/bob' },
    ]);
  });

  it('derives the hot-memory slug from the key, not the handle', () => {
    // The whole reason the key exists: the page name must survive a handle change.
    const [ada] = configUsers(TWO_PEOPLE);
    expect(ada.hotMemorySlug).toBe('users/ada');
  });

  it('treats enabled:false as disabled but still present', () => {
    const [bob] = configUsers({ users: { bob: { enabled: false } } });
    expect(bob.enabled).toBe(false);
  });

  it('skips a null entry, which is how the local layer deletes one', () => {
    const cfg = { users: { ada: { telegramHandle: 'ada_marlow' }, bob: null } } as unknown as LunaConfigDoc;
    expect(configUsers(cfg).map((u) => u.key)).toEqual(['ada']);
  });

  it('is empty for an install with no roster', () => {
    expect(configUsers({})).toEqual([]);
  });
});

describe('ownerKey / rosterUser', () => {
  it('reads the owner key', () => {
    expect(ownerKey(TWO_PEOPLE)).toBe('ada');
    expect(ownerKey({})).toBeNull();
    expect(ownerKey({ owner: '  ' })).toBeNull();
  });

  it('looks a person up by key', () => {
    expect(rosterUser('bo', TWO_PEOPLE)?.name).toBe('bo');
    expect(rosterUser('nobody', TWO_PEOPLE)).toBeUndefined();
    expect(rosterUser(null, TWO_PEOPLE)).toBeUndefined();
  });
});

describe('matchRosterByIdentity', () => {
  it('matches a Telegram handle case-insensitively', () => {
    expect(matchRosterByIdentity('telegram', { username: '@ADA_MARLOW' }, TWO_PEOPLE)?.key).toBe('ada');
    expect(matchRosterByIdentity('telegram', { username: 'bo_luna' }, TWO_PEOPLE)?.key).toBe('bo');
  });

  it('does not match an unlisted handle', () => {
    expect(matchRosterByIdentity('telegram', { username: 'stranger' }, TWO_PEOPLE)).toBeUndefined();
  });

  it('does not match when the platform reports no username', () => {
    // Telegram accounts without a public @username expose nothing to match on; those bind via
    // `luna users bind` instead of silently attaching to whoever is first in the config.
    expect(matchRosterByIdentity('telegram', { username: null }, TWO_PEOPLE)).toBeUndefined();
    expect(matchRosterByIdentity('telegram', {}, TWO_PEOPLE)).toBeUndefined();
  });

  it('still matches a disabled user, so the gate can say "refused" not "unknown"', () => {
    const cfg: LunaConfigDoc = { users: { bob: { telegramHandle: 'bob', enabled: false } }, owner: 'bob' };
    const match = matchRosterByIdentity('telegram', { username: 'bob' }, cfg);
    expect(match?.key).toBe('bob');
    expect(match?.enabled).toBe(false);
  });

  it('ignores channels that carry no handle', () => {
    expect(matchRosterByIdentity('cli', { username: 'ada_marlow' }, TWO_PEOPLE)).toBeUndefined();
  });
});

describe('validateRoster', () => {
  it('accepts a well-formed roster', () => {
    expect(validateRoster(TWO_PEOPLE)).toEqual([]);
  });

  it('accepts a bare install with no users and no owner', () => {
    // Valid pre-setup state. The host terminal is privileged regardless.
    expect(validateRoster({})).toEqual([]);
  });

  it('rejects a roster with users but no owner', () => {
    const errors = validateRoster({ users: { ada: { telegramHandle: 'ada_marlow' } } });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('owner is not set');
  });

  it('rejects an owner naming a key that does not exist', () => {
    const errors = validateRoster({ users: { ada: {} }, owner: 'andrei' });
    expect(errors.map((e) => e.message).join(' ')).toContain('not a key under users');
  });

  it('rejects a disabled owner', () => {
    const errors = validateRoster({ users: { ada: { enabled: false } }, owner: 'ada' });
    expect(errors.map((e) => e.message).join(' ')).toContain('disabled');
  });

  it('rejects a duplicate telegram handle', () => {
    const errors = validateRoster({
      users: { ada: { telegramHandle: 'ada_marlow' }, alt: { telegramHandle: '@ADA_MARLOW' } },
      owner: 'ada',
    });
    expect(errors.map((e) => e.message).join(' ')).toContain('claimed by more than one user');
  });

  it('rejects a key that cannot be a memory page name', () => {
    const errors = validateRoster({ users: { 'Ada Marlow': {} }, owner: 'Ada Marlow' });
    expect(errors.some((e) => e.message.includes('lowercase'))).toBe(true);
  });

  it('rejects a key containing a colon', () => {
    const errors = validateRoster({ users: { 'telegram:1000000001': {} }, owner: 'telegram:1000000001' });
    expect(errors.some((e) => e.message.includes('":"'))).toBe(true);
  });

  it('rejects the reserved key "shared"', () => {
    // users/shared is the everyone-page; a person named shared would shadow it.
    const errors = validateRoster({ users: { shared: {} }, owner: 'shared' });
    expect(errors.some((e) => e.message.includes('reserved'))).toBe(true);
  });

  it('rejects a memoryPage that is a path rather than a slug', () => {
    for (const memoryPage of ['/people/jane', 'people/jane.md']) {
      const errors = validateRoster({ users: { jane: { memoryPage } }, owner: 'jane' });
      expect(errors.some((e) => e.message.includes('slug'))).toBe(true);
    }
  });
});
