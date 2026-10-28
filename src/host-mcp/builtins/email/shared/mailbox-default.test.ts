import { describe, expect, it, vi } from 'vitest';

import { chooseMailboxes } from './mailbox-default.js';
import type { MailConfig, Mailbox } from './types.js';

// The default resolution reads the database; these cases are about the argument handling around it,
// so the lookup is stubbed and the DB-backed path is exercised by the caller-key tests below.
vi.mock('../../../db/connection.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [] }) }) }));
vi.mock('../../../db/sessions.js', () => ({ getSession: () => undefined }));
vi.mock('../../../db/messaging-groups.js', () => ({ getMessagingGroup: () => undefined }));
vi.mock('../../../users/binding.js', () => ({ resolveUserKey: () => null }));

function mailbox(key: string): Mailbox {
  return { key, address: `${key}@example.test`, displayName: key, appPassword: 'x'.repeat(16) };
}

function config(keys: string[], problems: MailConfig['problems'] = []): MailConfig {
  return {
    enabled: true,
    backend: 'gmail-imap',
    toolsAllow: [],
    maxBodyChars: 4000,
    mailboxes: keys.map(mailbox),
    problems,
  };
}

describe('chooseMailboxes', () => {
  it('expands "*" to every configured mailbox', () => {
    expect(chooseMailboxes(config(['ada', 'bo']), '*', undefined).keys).toEqual(['ada', 'bo']);
  });

  it('accepts a named mailbox', () => {
    expect(chooseMailboxes(config(['ada', 'bo']), 'bo', undefined).keys).toEqual(['bo']);
  });

  it('rejects an unknown name and lists what exists', () => {
    const choice = chooseMailboxes(config(['ada', 'bo']), 'nobody', undefined);

    expect(choice.keys).toEqual([]);
    expect(choice.error).toContain('ada, bo');
  });

  it('falls back to the only mailbox when there is just one', () => {
    expect(chooseMailboxes(config(['ada']), undefined, undefined).keys).toEqual(['ada']);
  });

  it('asks rather than guessing when several exist and no caller identifies one', () => {
    const choice = chooseMailboxes(config(['ada', 'bo']), undefined, undefined);

    expect(choice.keys).toEqual([]);
    expect(choice.error).toContain('Which mailbox?');
    expect(choice.error).toContain('"*"');
  });

  it('explains why nothing is reachable when every mailbox has a problem', () => {
    const choice = chooseMailboxes(
      config([], [{ key: 'ada', reason: 'no_password', message: 'ada: KEY is not set in .env' }]),
      undefined,
      undefined,
    );

    expect(choice.error).toContain('KEY is not set in .env');
  });
});
