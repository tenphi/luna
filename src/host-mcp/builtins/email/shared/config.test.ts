import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LunaConfigDoc } from '../../../../config/schema.js';
import { loadMailConfig } from './config.js';

vi.mock('../../../../config/write.js', () => ({ patchLocalConfig: vi.fn() }));

const ENV_KEY = 'LUNA_MAIL_TESTER_APP_PASSWORD';

function doc(overrides: Partial<LunaConfigDoc> = {}): LunaConfigDoc {
  return {
    email: { enabled: true },
    users: {
      tester: { name: 'Tester', email: { address: 'tester@example.test', appPassword: { env: ENV_KEY } } },
    },
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env[ENV_KEY];
  delete process.env.LUNA_EMAIL_ENABLED;
});

describe('loadMailConfig', () => {
  it('combines global and per-mailbox exclusions without widening either', () => {
    process.env[ENV_KEY] = 'sixteencharacter';
    const input = doc();
    input.email = { enabled: true, ignoreLabels: ['Global'], ignoreSenders: ['Notice@Example.test'] };
    input.users!.tester!.email!.ignoreLabels = ['Work'];
    expect(loadMailConfig(input).mailboxes[0]).toMatchObject({
      ignoreLabels: ['Global', 'Work'],
      ignoreSenders: ['notice@example.test'],
    });
  });
  it('resolves a mailbox from the roster plus the env secret', () => {
    process.env[ENV_KEY] = 'sixteencharacter';

    const config = loadMailConfig(doc());

    expect(config.mailboxes).toEqual([
      {
        key: 'tester',
        address: 'tester@example.test',
        displayName: 'Tester',
        appPassword: 'sixteencharacter',
        ignoreLabels: [],
        ignoreSenders: [],
      },
    ]);
    expect(config.problems).toEqual([]);
  });

  it('names the missing env var rather than blaming the config file', () => {
    const config = loadMailConfig(doc());

    expect(config.mailboxes).toEqual([]);
    expect(config.problems[0]).toMatchObject({ key: 'tester', reason: 'no_password' });
    expect(config.problems[0]?.message).toContain(ENV_KEY);
  });

  it('reports a mailbox with no address as a problem, not as absent', () => {
    process.env[ENV_KEY] = 'sixteencharacter';
    const config = loadMailConfig(
      doc({ users: { tester: { name: 'Tester', email: { appPassword: { env: ENV_KEY } } } } }),
    );

    expect(config.problems[0]).toMatchObject({ reason: 'no_address' });
  });

  it('says nothing about a person who simply has no mailbox', () => {
    const config = loadMailConfig(doc({ users: { tester: { name: 'Tester' } } }));

    expect(config.mailboxes).toEqual([]);
    expect(config.problems).toEqual([]);
  });

  it('treats a disabled mailbox as a reported problem rather than a silent skip', () => {
    process.env[ENV_KEY] = 'sixteencharacter';
    const config = loadMailConfig(
      doc({
        users: {
          tester: {
            name: 'Tester',
            email: { address: 'a@example.test', appPassword: { env: ENV_KEY }, enabled: false },
          },
        },
      }),
    );

    expect(config.problems[0]).toMatchObject({ reason: 'disabled' });
  });

  it('honours the env kill switch over the config', () => {
    process.env[ENV_KEY] = 'sixteencharacter';
    process.env.LUNA_EMAIL_ENABLED = 'false';

    expect(loadMailConfig(doc()).enabled).toBe(false);
  });

  it('falls back to product defaults for the install-wide knobs', () => {
    const config = loadMailConfig(doc());

    expect(config.backend).toBe('gmail-imap');
    expect(config.maxBodyChars).toBeGreaterThan(0);
    expect(config.toolsAllow).toContain('search_mail');
    // Sending is opt-in: shipping it on by default would make an irreversible action the default.
    expect(config.toolsAllow).not.toContain('send_mail');
  });
});
