/**
 * Normalize an inbound slash command token.
 * Strips Telegram's @botname suffix (e.g. `/clear@mybot` → `/clear`).
 */
export function parseSlashCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const token = trimmed.split(/\s+/)[0]!.toLowerCase();
  const match = /^\/([a-z0-9_-]+)(?:@([a-z0-9_]+))?$/i.exec(token);
  if (!match) return null;

  return `/${match[1]!.toLowerCase()}`;
}
