/**
 * The slash commands Luna answers, in one place.
 *
 * This list drives the command gate, the Telegram command menu, the `/help`
 * reply, and the CLI banner. It used to be three hand-synced lists in three
 * files, which is how `/help` ended up in the silently-dropped set: a user who
 * asked what they could do got no reply at all, from an assistant that has
 * nine other commands it answers happily.
 */
export interface SlashCommandSpec {
  /** Command including the leading slash. */
  name: string;
  /** One line, as shown in the Telegram menu and `/help`. */
  description: string;
  /** Owner-only commands are refused for everyone else. */
  ownerOnly: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: '/help', description: 'Show the commands you can use', ownerOnly: false },
  { name: '/clear', description: 'Clear session context', ownerOnly: false },
  { name: '/stop', description: 'Stop current activity', ownerOnly: false },
  { name: '/learn', description: 'Toggle background memory learning (on/off)', ownerOnly: false },
  // Host-handled: the moment worth reporting is often the moment the agent is
  // misbehaving, so this must not depend on the agent to record it.
  { name: '/report', description: 'Flag this conversation as gone wrong, with a note', ownerOnly: false },
  // Memory, host-handled: one command per memory op, named after it. They answer
  // without waking the container, which is the point — the moment you most want to
  // look something up by hand is when the agent is wedged.
  { name: '/read', description: 'Read a memory page', ownerOnly: false },
  { name: '/raw', description: 'Read a memory page exactly as stored', ownerOnly: false },
  { name: '/download', description: 'Send the files attached to a memory page', ownerOnly: false },
  { name: '/list', description: 'List memory folders and pages', ownerOnly: false },
  { name: '/timelines', description: 'Discover memory timelines', ownerOnly: false },
  { name: '/timeline', description: 'Read a timeline: <ledger|*> [since] [until]', ownerOnly: false },
  { name: '/recall', description: 'Search memory', ownerOnly: false },
  // Open, like the reads. This is a shared agent: the memory is the household's,
  // not one account's, and the person best placed to correct a wrong sentence is
  // whoever spotted it. Both are reversible, and `/undo` is the reversal.
  { name: '/forget', description: 'Remove a wrong memory item — say what it says', ownerOnly: false },
  { name: '/delete', description: 'Delete a memory page (goes to trash)', ownerOnly: false },
  { name: '/restore', description: 'List deleted pages, or bring one back', ownerOnly: false },
  { name: '/undo', description: 'Reverse the last memory change, or one by id', ownerOnly: false },
  { name: '/compact', description: 'Compact context', ownerOnly: true },
  { name: '/context', description: 'Show context usage', ownerOnly: true },
  { name: '/usage', description: 'Show token usage', ownerOnly: true },
  { name: '/files', description: 'List session files', ownerOnly: true },
  { name: '/topics', description: 'List recent topics', ownerOnly: true },
  { name: '/tasks', description: 'List all scheduled tasks', ownerOnly: true },
  { name: '/kill', description: 'Kill agent container', ownerOnly: true },
  { name: '/restart', description: 'Rebuild and restart agent', ownerOnly: true },
  { name: '/health', description: 'Install health check', ownerOnly: true },
];

/**
 * Render the command list for a chat reply.
 *
 * Non-owners only see what they can actually run — listing `/restart` to
 * someone who will be told "permission denied" is worse than not listing it.
 */
export function renderCommandHelp(isOwner: boolean): string {
  const visible = SLASH_COMMANDS.filter((c) => isOwner || !c.ownerOnly);
  const width = Math.max(...visible.map((c) => c.name.length));
  const lines = visible.map((c) => `${c.name.padEnd(width)}  ${c.description}`);
  return ['Commands:', ...lines].join('\n');
}

/**
 * One-line form for the CLI banner, where a dozen described commands would push
 * the first prompt off the top of a short terminal.
 */
export function renderCommandNames(isOwner: boolean): string {
  return SLASH_COMMANDS.filter((c) => isOwner || !c.ownerOnly)
    .map((c) => c.name)
    .join(' ');
}
