/**
 * Telegram Bot API command-menu registration.
 *
 * Writes the same Luna slash-command list to every BotCommandScope that
 * commonly retains leftovers (default + all_private_chats + all_group_chats
 * + all_chat_administrators). More-specific scopes override default, so
 * commands left by an earlier bot setup can hide Luna's menu until those
 * scopes are overwritten.
 */
import { SLASH_COMMANDS } from '../commands.js';
import { log } from '../log.js';

export interface TelegramBotCommand {
  command: string;
  description: string;
}

/**
 * Telegram menu, derived from the canonical list in `src/commands.ts`.
 *
 * Telegram shows one menu to everyone, so owner-only entries are labelled
 * rather than hidden — a non-owner who picks one gets the permission-denied
 * reply, which is clearer than a command that appears not to exist.
 */
export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommand[] = SLASH_COMMANDS.map((c) => ({
  command: c.name.slice(1),
  description: c.ownerOnly ? `${c.description} (owner)` : c.description,
}));

const SCOPES: ReadonlyArray<{ type: string } | undefined> = [
  undefined, // BotCommandScopeDefault
  { type: 'all_private_chats' },
  { type: 'all_group_chats' },
  { type: 'all_chat_administrators' },
];

export type RegisterTelegramBotCommandsResult = { ok: true; scopes: number } | { ok: false; error: string };

/**
 * Register Luna's slash-command menu on all relevant Telegram scopes.
 * Returns a structured result so setup can surface failures; the host
 * adapter logs and continues on failure.
 */
export async function registerTelegramBotCommands(token: string): Promise<RegisterTelegramBotCommandsResult> {
  const commands = TELEGRAM_BOT_COMMANDS.map((c) => ({ ...c }));
  let registered = 0;

  try {
    for (const scope of SCOPES) {
      const body: Record<string, unknown> = { commands };
      if (scope) body.scope = scope;

      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      let json: { ok?: boolean; description?: string };
      try {
        json = (await res.json()) as { ok?: boolean; description?: string };
      } catch {
        const error = `setMyCommands HTTP ${res.status} (invalid JSON)`;
        log.warn('Telegram setMyCommands failed', { scope: scope?.type ?? 'default', error });
        return { ok: false, error };
      }

      if (!res.ok || !json.ok) {
        const error = json.description ?? `HTTP ${res.status}`;
        log.warn('Telegram setMyCommands failed', {
          scope: scope?.type ?? 'default',
          status: res.status,
          error,
        });
        return { ok: false, error };
      }
      registered += 1;
    }

    log.info('Telegram bot commands registered', {
      scopes: registered,
      commands: commands.length,
    });
    return { ok: true, scopes: registered };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('Telegram setMyCommands failed', { err });
    return { ok: false, error };
  }
}
