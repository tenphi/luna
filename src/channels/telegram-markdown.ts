/**
 * Normalize GFM for Telegram Rich Messages.
 *
 * Telegram does not auto-increment lazy ordered-list markers (`1.` on every
 * item), and unindented `-` bullets under a `1.` item break the list into
 * separate one-item lists (each starting at 1). This module nests those loose
 * sub-bullets, then parse/stringify via the Chat SDK's GFM round-trip so
 * markers become 1, 2, 3.
 */
import { parseMarkdown, stringifyMarkdown } from 'chat';

const ORDERED_ITEM = /^\d+\.\s/;
const UNINDENTED_BULLET = /^[-*+]\s/;
const INDENTED_NEST = /^\s+([-*+]|\d+\.)\s/;

/**
 * After a `1. item` line, indent following unindented `[-*+]` lines so they
 * nest under that item. Clears nesting context on blank lines or other content.
 * Leaves already-indented nested items alone.
 */
export function nestLooseSublists(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inOrderedItem = false;

  for (const line of lines) {
    if (ORDERED_ITEM.test(line)) {
      inOrderedItem = true;
      out.push(line);
      continue;
    }
    if (line.trim() === '') {
      inOrderedItem = false;
      out.push(line);
      continue;
    }
    if (inOrderedItem && UNINDENTED_BULLET.test(line)) {
      out.push(`   ${line}`);
      continue;
    }
    if (inOrderedItem && INDENTED_NEST.test(line)) {
      out.push(line);
      continue;
    }
    inOrderedItem = false;
    out.push(line);
  }

  return out.join('\n');
}

/** Fenced blocks and inline code, where angle brackets are content, not markup. */
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/;

const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g;

/**
 * The round-trip parses a bare URL as a GFM literal autolink and writes it back
 * in `<url>` form. Telegram shows those brackets verbatim, so put the bare URL
 * back — outside code, where the brackets may be exactly what was written.
 */
export function unwrapAutolinks(md: string): string {
  return md
    .split(CODE_SPAN)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(AUTOLINK, (_, url: string) => url.replace(/^mailto:/i, ''))))
    .join('');
}

/**
 * Canonicalize Telegram outbound markdown so ordered lists display as 1, 2, 3.
 * Returns the original string if parse/stringify fails.
 */
export function normalizeTelegramMarkdown(md: string): string {
  if (!md) return md;
  try {
    const out = unwrapAutolinks(stringifyMarkdown(parseMarkdown(nestLooseSublists(md)), { bullet: '-' }));
    // remark-stringify appends a trailing newline; drop it so delivery matches input shape.
    return out.endsWith('\n') ? out.slice(0, -1) : out;
  } catch {
    return md;
  }
}
