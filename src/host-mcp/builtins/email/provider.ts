import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BuiltinMcpProvider, BuiltinServerInfo } from '../types.js';
import { createEmailMcpServer } from './servers/email.js';
import type { MailBackend } from './shared/backend.js';
import { EMAIL_SERVER_KEY, isMailEnabled, loadMailConfig } from './shared/config.js';
import { probeMailHealth, writeMailHealth } from './shared/health.js';
import { GmailImapBackend } from './shared/imap/backend.js';

/**
 * The mail builtin.
 *
 * Unlike the Apple builtins this is not macOS-only — it talks to Gmail over the network, and there
 * is nothing platform-specific left now that there is no CLI to install.
 */

let backend: MailBackend | null = null;

export function isEmailBuiltinEnabled(): boolean {
  return isMailEnabled();
}

/** Closed on host shutdown so Gmail sees a logout rather than a timeout. */
export async function closeEmailBackend(): Promise<void> {
  const open = backend;
  backend = null;
  if (open) await open.close().catch(() => {});
}

export const emailProvider: BuiltinMcpProvider = {
  id: 'email',

  isEnabled: isEmailBuiltinEnabled,

  listServers(): BuiltinServerInfo[] {
    if (!isEmailBuiltinEnabled()) return [];
    return [{ name: EMAIL_SERVER_KEY, oneCli: false }];
  },

  async prepare() {
    const config = loadMailConfig();
    const factories: Record<string, () => McpServer> = {};
    const disabledServerNames = new Set<string>();

    // Worth a line either way: a mailbox configured but unusable is the failure that otherwise
    // looks exactly like never having configured one.
    for (const problem of config.problems) {
      console.error(`[email] ${problem.message}`);
    }

    if (!config.enabled) {
      console.error('[email] disabled');
      disabledServerNames.add(EMAIL_SERVER_KEY);
      return { factories, disabledServerNames };
    }

    if (config.mailboxes.length === 0) {
      console.error('[email] not starting — no usable mailbox (run setup --step email)');
      disabledServerNames.add(EMAIL_SERVER_KEY);
      return { factories, disabledServerNames };
    }

    backend = new GmailImapBackend(config.mailboxes);

    // Probing at boot rather than on the first tool call: a revoked app password should show up in
    // the log and in `luna health` before someone asks about their mail, not instead of an answer.
    const health = await probeMailHealth(config, backend);
    writeMailHealth(health);
    console.error(`[email] [${health.status}] ${health.message}`);

    factories[EMAIL_SERVER_KEY] = () => createEmailMcpServer(config, backend!);
    return { factories, disabledServerNames };
  },
};
