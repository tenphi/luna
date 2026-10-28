/**
 * Whether mail actually works, per mailbox.
 *
 * The old check asked whether a CLI was installed, which answered a question nobody had: a present
 * binary and a working mailbox are unrelated. What breaks in practice is one credential — an app
 * password revoked, a `.env` line lost in a redeploy — and that fails for one person while the
 * other's mail keeps working. So health is reported per mailbox and the overall status is the worst
 * of them, because "email: ok" while bo's mailbox has been unreachable for a week is the
 * failure mode worth designing against.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../../config.js';
import { log } from '../../../../log.js';
import type { MailBackend } from './backend.js';
import type { MailConfig, MailHealth, MailboxHealth } from './types.js';

export function healthFilePath(): string {
  return path.join(DATA_DIR, 'email', 'health.json');
}

export async function probeMailHealth(config: MailConfig, backend: MailBackend | null): Promise<MailHealth> {
  const checkedAt = new Date().toISOString();

  if (!config.enabled) {
    return { status: 'disabled', message: 'Email builtin is disabled', mailboxes: [], checkedAt };
  }

  if (config.mailboxes.length === 0) {
    const detail = config.problems.length > 0 ? `: ${config.problems.map((p) => p.message).join('; ')}` : '';
    return { status: 'no_mailboxes', message: `No usable mailbox${detail}`, mailboxes: [], checkedAt };
  }

  const mailboxes: MailboxHealth[] = backend
    ? await Promise.all(config.mailboxes.map((m) => backend.probe(m.key)))
    : config.mailboxes.map((m) => ({ key: m.key, address: m.address, ok: false, detail: 'backend not started' }));

  const failed = mailboxes.filter((m) => !m.ok);
  if (failed.length === 0) {
    return {
      status: 'ok',
      message: `${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'} reachable`,
      mailboxes,
      checkedAt,
    };
  }

  const authFailed = failed.some((m) => /authentication failed/i.test(m.detail));
  return {
    status: authFailed ? 'auth_failed' : 'unreachable',
    message: failed.map((m) => `${m.key} (${m.address}): ${m.detail}`).join('; '),
    mailboxes,
    checkedAt,
  };
}

/** Persist the last probe, so `luna health` can report without opening connections of its own. */
export function writeMailHealth(health: MailHealth): void {
  try {
    const file = healthFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(health, null, 2)}\n`, 'utf-8');
  } catch (err) {
    log.debug('could not write mail health', { err });
  }
}

export function readMailHealth(): MailHealth | null {
  try {
    return JSON.parse(fs.readFileSync(healthFilePath(), 'utf-8')) as MailHealth;
  } catch {
    return null;
  }
}
