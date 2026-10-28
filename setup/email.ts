/**
 * Step: email — give each person in the roster a Gmail mailbox.
 *
 * One app password per person, verified by an actual login before anything is written, stored in
 * `.env`, referenced from `config/local.jsonc` by env-var name. Nothing here reaches out to a CLI or
 * writes a config file for some other program to read.
 *
 * It also migrates the previous install: the old builtin kept its Gmail app password in the macOS
 * keychain, where Himalaya's `auth.command` fetched it. That password is a perfectly good Gmail app
 * password, so this offers to reuse it rather than asking someone to generate a new one and revoke
 * the old — but it verifies it first, because a credential that has been sitting in a keychain for
 * a year may well have been revoked in the meantime.
 */
import { execFileSync } from 'child_process';
import * as p from '@clack/prompts';

import { loadLunaConfig } from '../src/config/loader.js';
import { patchLocalConfig, writeLocalConfig } from '../src/config/write.js';
import { readEnvFile, writeEnvFile } from '../src/env.js';
import { GmailImapBackend } from '../src/host-mcp/builtins/email/shared/imap/backend.js';
import { log } from '../src/log.js';
import { configUsers } from '../src/users/roster.js';
import { emitStatus } from './status.js';

/** The keychain item the retired Himalaya config read its IMAP password from. */
const LEGACY_KEYCHAIN_ACCOUNT = 'gmail';
const LEGACY_KEYCHAIN_SERVICE = 'himalaya-gmail-imap';

function envKeyFor(userKey: string): string {
  return `LUNA_MAIL_${userKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_APP_PASSWORD`;
}

function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

/** The old password, if the keychain still has it. Never logged, never printed. */
function readLegacyKeychainPassword(): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', LEGACY_KEYCHAIN_ACCOUNT, '-s', LEGACY_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim() || null;
  } catch {
    // Missing item, or the user dismissed the keychain prompt. Both mean "ask instead".
    return null;
  }
}

/**
 * Log in once before writing anything.
 *
 * A wrong app password otherwise produces a config that looks complete and a mailbox that never
 * works, discovered at the first question about mail rather than here where it can be retyped.
 */
async function verify(address: string, appPassword: string): Promise<string | null> {
  const backend = new GmailImapBackend([{ key: 'probe', address, displayName: null, appPassword }]);
  try {
    const health = await backend.probe('probe');
    return health.ok ? null : health.detail;
  } finally {
    await backend.close().catch(() => {});
  }
}

const APP_PASSWORD_HELP =
  'Generate one at https://myaccount.google.com/apppasswords (2-Step Verification must be on). ' +
  'It is 16 characters; spaces are ignored.';

async function promptAppPassword(address: string): Promise<string | null> {
  const value = await p.password({
    message: `Gmail app password for ${address}`,
    validate: (raw) => {
      const cleaned = String(raw ?? '').replace(/\s+/g, '');
      if (cleaned.length < 16) return `That is not an app password. ${APP_PASSWORD_HELP}`;
      return undefined;
    },
  });
  if (isCancel(value)) throw new Error('Setup cancelled');
  return String(value).replace(/\s+/g, '');
}

interface Configured {
  userKey: string;
  address: string;
  envKey: string;
}

async function configureMailbox(
  userKey: string,
  name: string,
  legacyPassword: string | null,
): Promise<Configured | null> {
  const cfg = loadLunaConfig();
  const existing = cfg.users?.[userKey]?.email;
  const envKey = envKeyFor(userKey);
  const alreadySet = Boolean(readEnvFile([envKey])[envKey]);

  if (existing?.address && alreadySet) {
    const keep = await p.confirm({
      message: `${name} already has ${existing.address} configured. Keep it?`,
      initialValue: true,
    });
    if (isCancel(keep)) throw new Error('Setup cancelled');
    if (keep) return { userKey, address: existing.address, envKey };
  }

  const addressValue = await p.text({
    message: `Gmail address for ${name}`,
    placeholder: 'ada@example.test',
    initialValue: existing?.address ?? '',
    validate: (raw) =>
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(raw ?? '').trim()) ? undefined : 'Enter an email address',
  });
  if (isCancel(addressValue)) throw new Error('Setup cancelled');
  const address = String(addressValue).trim();

  let appPassword: string | null = null;

  if (legacyPassword) {
    const reuse = await p.confirm({
      message: `Reuse the app password already in your keychain for ${address}?`,
      initialValue: true,
    });
    if (isCancel(reuse)) throw new Error('Setup cancelled');
    if (reuse) appPassword = legacyPassword;
  }

  for (;;) {
    if (!appPassword) appPassword = await promptAppPassword(address);
    if (!appPassword) return null;

    const spinner = p.spinner();
    spinner.start(`Signing in to ${address}`);
    const failure = await verify(address, appPassword);
    spinner.stop(failure ? `Could not sign in to ${address}` : `Signed in to ${address}`);

    if (!failure) break;

    p.log.error(failure);
    const retry = await p.confirm({ message: 'Try a different app password?', initialValue: true });
    if (isCancel(retry) || !retry) return null;
    appPassword = null;
  }

  writeEnvFile({ [envKey]: appPassword });
  writeLocalConfig({
    users: { [userKey]: { email: { address, appPassword: { env: envKey } } } },
  });

  return { userKey, address, envKey };
}

export async function run(_args: string[]): Promise<void> {
  p.intro('Luna email (Gmail)');

  const users = configUsers(loadLunaConfig()).filter((u) => u.enabled);
  if (users.length === 0) {
    const msg = 'No people are configured — add them with `luna config users set` first.';
    emitStatus('EMAIL', { STATUS: 'pending', REASON: 'no_users' });
    p.outro(msg);
    return;
  }

  const legacy = readLegacyKeychainPassword();
  if (legacy) {
    p.log.info('Found the app password from the previous email setup in your keychain — it can be reused.');
  }

  const configured: Configured[] = [];
  let legacyOffer = legacy;

  for (const user of users) {
    const result = await configureMailbox(user.key, user.name, legacyOffer);
    if (result) {
      configured.push(result);
      // The keychain held one account's password. Once it has been claimed, stop offering it for
      // everyone else — a shared credential across two mailboxes is not a thing that works.
      legacyOffer = null;
    } else {
      p.log.warn(`Skipped ${user.name} — no mailbox configured.`);
    }
  }

  if (configured.length === 0) {
    emitStatus('EMAIL', { STATUS: 'pending', REASON: 'no_mailboxes' });
    p.outro('No mailboxes configured.');
    return;
  }

  // Enabling last, and only once at least one mailbox verified, so a cancelled run never leaves the
  // builtin switched on with nothing behind it.
  //
  // `{ enabled: true }` alone, deliberately. Spreading the *loaded* config in would copy every
  // product default out of `default.jsonc` and freeze it into the local overlay — which is how an
  // install ends up pinned to a `toolsAllow` from whichever release it was set up under, silently
  // not gaining tools that later ship. The overlay is for overrides; `patchLocalConfig` merges.
  patchLocalConfig('email', { enabled: true });

  const summary = configured.map((c) => `  ${c.userKey}: ${c.address} (${c.envKey})`).join('\n');
  log.info('Email setup complete', { mailboxes: configured.map((c) => c.userKey) });
  emitStatus('EMAIL', { STATUS: 'success', MAILBOXES: configured.map((c) => c.userKey).join(',') });

  const cleanup = legacy
    ? '\n\nThe old keychain item is no longer read by anything. Remove it when you are ready:\n' +
      `  security delete-generic-password -a ${LEGACY_KEYCHAIN_ACCOUNT} -s ${LEGACY_KEYCHAIN_SERVICE}\n` +
      '  brew uninstall himalaya'
    : '';

  p.outro(
    `Configured:\n${summary}\n\nRebuild and restart the Luna host:\n  pnpm run build && luna service restart${cleanup}`,
  );
}
