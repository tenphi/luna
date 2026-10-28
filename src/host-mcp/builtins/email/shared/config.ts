/**
 * Turning `users.<key>.email` into mailboxes the backend can open.
 *
 * Mailboxes hang off people rather than living in an account registry, so this walks the roster
 * instead of an `email.accounts` map. A person without an `email` block simply has no mailbox; a
 * person with a half-filled one is a *problem*, reported by key, because silently skipping it looks
 * identical to never having configured it and is the harder failure to diagnose.
 */
import { loadLunaConfig, resolveSecretOrValue } from '../../../../config/loader.js';
import {
  DEFAULT_EMAIL_DOC,
  EMAIL_DEFAULT_MAX_BODY_CHARS,
  EMAIL_DEFAULT_TOOLS_ALLOW,
} from '../../../../config/email-defaults.js';
import { sanitizeEmailForLocalOverlay } from '../../../../config/sanitize.js';
import type { LunaConfigDoc } from '../../../../config/schema.js';
import { patchLocalConfig } from '../../../../config/write.js';
import { readEnvFile } from '../../../../env.js';
import { configUsers } from '../../../../users/roster.js';
import type { MailConfig, Mailbox, MailboxProblem } from './types.js';
import { exclusionList } from './exclusions.js';

export { EMAIL_SERVER_KEY } from './types.js';

const ENV_ENABLED = 'LUNA_EMAIL_ENABLED';

function envKillSwitch(): boolean {
  const fromProcess = process.env[ENV_ENABLED];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess === 'false';
  return readEnvFile([ENV_ENABLED])[ENV_ENABLED] === 'false';
}

/**
 * Resolve every roster mailbox.
 *
 * Order follows the roster, so `list_mailboxes` and any fan-out search are stable across runs —
 * an agent that saw one order last turn sees the same one this turn.
 */
export function loadMailConfig(cfg: LunaConfigDoc = loadLunaConfig()): MailConfig {
  const doc = cfg.email ?? {};
  const ignoreLabels = exclusionList(doc.ignoreLabels, 'labels');
  const ignoreSenders = exclusionList(doc.ignoreSenders, 'senders');
  const mailboxes: Mailbox[] = [];
  const problems: MailboxProblem[] = [];

  for (const user of configUsers(cfg)) {
    const mail = cfg.users?.[user.key]?.email;
    if (!mail) continue;

    if (mail.enabled === false) {
      problems.push({ key: user.key, reason: 'disabled', message: `${user.key}: mailbox is disabled in config` });
      continue;
    }

    const address = mail.address?.trim();
    if (!address) {
      problems.push({
        key: user.key,
        reason: 'no_address',
        message: `${user.key}: users.${user.key}.email.address is missing`,
      });
      continue;
    }

    const appPassword = resolveSecretOrValue(mail.appPassword);
    if (!appPassword) {
      // Naming the env var rather than saying "no password": the config holds a *reference*, and
      // the thing that is actually missing is a line in .env, which is not where someone looks
      // when the error names the config file.
      const ref = typeof mail.appPassword === 'object' && mail.appPassword ? mail.appPassword.env : null;
      problems.push({
        key: user.key,
        reason: 'no_password',
        message: ref
          ? `${user.key}: ${ref} is not set in .env`
          : `${user.key}: users.${user.key}.email.appPassword is missing`,
      });
      continue;
    }

    mailboxes.push({
      key: user.key,
      address,
      displayName: mail.displayName?.trim() || user.name || null,
      appPassword,
      ignoreLabels: [...new Set([...ignoreLabels, ...exclusionList(mail.ignoreLabels, 'labels')])],
      ignoreSenders: [...new Set([...ignoreSenders, ...exclusionList(mail.ignoreSenders, 'senders')])],
    });
  }

  return {
    ignoreLabels,
    ignoreSenders,
    enabled: (doc.enabled ?? DEFAULT_EMAIL_DOC.enabled ?? false) && !envKillSwitch(),
    backend: doc.backend ?? 'gmail-imap',
    toolsAllow: doc.toolsAllow ?? [...EMAIL_DEFAULT_TOOLS_ALLOW],
    maxBodyChars: doc.maxBodyChars ?? EMAIL_DEFAULT_MAX_BODY_CHARS,
    mailboxes,
    problems,
  };
}

/**
 * Persist the install-wide half to `config/local.jsonc`.
 *
 * Only the install-wide half. Mailboxes live on `users.<key>.email` and are written by setup
 * alongside the `.env` line that carries the secret — writing one without the other leaves a config
 * that references a key nobody set, which is exactly the state this reports as a problem.
 */
export function saveMailConfig(
  config: Pick<MailConfig, 'enabled' | 'backend' | 'toolsAllow' | 'maxBodyChars' | 'ignoreLabels' | 'ignoreSenders'>,
): void {
  const doc = sanitizeEmailForLocalOverlay({
    enabled: config.enabled,
    backend: config.backend,
    toolsAllow: config.toolsAllow,
    maxBodyChars: config.maxBodyChars,
    ignoreLabels: exclusionList(config.ignoreLabels, 'labels'),
    ignoreSenders: exclusionList(config.ignoreSenders, 'senders'),
  });
  patchLocalConfig('email', doc);
}

/** True when the builtin should start at all: enabled, and at least one usable mailbox. */
export function isMailEnabled(config: MailConfig = loadMailConfig()): boolean {
  return config.enabled && config.mailboxes.length > 0;
}
