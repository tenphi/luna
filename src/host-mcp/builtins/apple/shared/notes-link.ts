/**
 * Links on reminders and events travel in the notes.
 *
 * Reminders.app never shows EventKit's `url` (its own URL field is a private attribute), and
 * calendar accounts such as Google or Exchange may drop it, so a link stored only there is
 * invisible while the readback still reports it. Appending the link to the notes puts it where
 * every app shows it; the EventKit `url` keeps the canonical copy, which tells a later update
 * which appended line to replace.
 */

/** Whether the value parses as an absolute URL (a bare domain does not). */
export function isLink(value: string): boolean {
  return URL.canParse(value.trim());
}

/** Canonical form for EventKit: percent-encoded, so Swift's URL(string:) never drops it. */
export function normalizeLink(value: string): string {
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) throw new Error(`Invalid url: ${value} (pass an absolute URL, e.g. https://…)`);
  return new URL(trimmed).href;
}

function sameLink(a: string, b: string): boolean {
  if (a === b) return true;
  return URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;
}

function containsLink(text: string, link: string): boolean {
  return text.includes(link) || (URL.canParse(link) && text.includes(new URL(link).href));
}

/** Notes with the link appended on its own line, unless the body already carries it. */
export function joinNotes(body: string | null | undefined, link: string | null | undefined): string | null {
  if (!link) return body ?? null;
  const text = body?.trimEnd() ?? '';
  if (containsLink(text, link)) return text;
  return text ? `${text}\n\n${link}` : link;
}

/** Notes without the appended line for `link`; a link elsewhere in the body is the user's text. */
export function stripLink(notes: string | null | undefined, link: string | null | undefined): string | null {
  if (!notes || !link) return notes ?? null;
  const lines = notes.trimEnd().split('\n');
  const last = lines.at(-1)!.trim();
  if (!sameLink(last, link)) return notes;
  return lines.slice(0, -1).join('\n').trimEnd() || null;
}

/**
 * Notes after an update that may change the body, the link, or both (undefined = unchanged).
 * The current link's line is dropped first, so a new link replaces it, a cleared one disappears,
 * and a rewritten body keeps the link. Undefined when neither side changes.
 */
export function updatedNotes(
  current: { notes?: string | null; url?: string | null },
  changes: { body?: string | null; url?: string | null },
): string | null | undefined {
  if (changes.body === undefined && changes.url === undefined) return undefined;
  const body = changes.body !== undefined ? changes.body : (current.notes ?? null);
  const link = changes.url !== undefined ? changes.url : (current.url ?? null);
  return joinNotes(stripLink(body, current.url), link);
}
