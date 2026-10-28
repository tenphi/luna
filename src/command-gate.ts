/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - `/help`: answered by the host with the command list
 * - Owner commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Unknown slash commands: never reach the container; host replies
 *   "Command not recognized"
 * - Normal messages: pass through unchanged
 */
import { SLASH_COMMANDS } from './commands.js';
import { parseSlashCommand } from './slash-command.js';
import { isOwner } from './users/binding.js';

export type GateResult =
  | { action: 'pass'; command?: string }
  | { action: 'filter' }
  | { action: 'help' }
  | { action: 'deny'; command: string }
  | { action: 'unrecognized'; command: string };

/**
 * Commands other bots and clients own, which we must ignore rather than answer.
 * Not the same thing as "unknown": replying "not recognized" to a `/login` meant
 * for a different bot in a shared group is noise.
 */
const FILTERED_COMMANDS = new Set(['/login', '/logout', '/doctor', '/config', '/remote-control']);
/** Session-scoped; any participant may use these (clear history / abort turn). */
export const OPEN_COMMANDS = new Set(SLASH_COMMANDS.filter((c) => !c.ownerOnly).map((c) => c.name));
export const OWNER_COMMANDS = new Set(SLASH_COMMANDS.filter((c) => c.ownerOnly).map((c) => c.name));

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages, open commands, and authorized owner
 * commands; 'filter' for silently-dropped commands; 'deny' for unauthorized
 * owner commands; 'unrecognized' for unknown slash commands.
 */
export function gateCommand(content: string, userId: string | null): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  const command = parseSlashCommand(text);
  if (!command) return { action: 'pass' };

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  // Answered by the host, not the agent — the list is host-side and a container
  // that is asleep or broken is exactly when you want to know what you can type.
  if (command === '/help') return { action: 'help' };

  if (OPEN_COMMANDS.has(command)) {
    return { action: 'pass', command };
  }

  if (OWNER_COMMANDS.has(command)) {
    if (userId !== null && isOwner(userId)) {
      return { action: 'pass', command };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands never reach the agent.
  return { action: 'unrecognized', command };
}
