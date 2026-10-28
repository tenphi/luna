/**
 * Building the Gmail search string that replaces the folder tree.
 *
 * The old builtin addressed mail by folder, which meant the agent had to know the folder layout,
 * ids meant different things in different folders, and keeping it out of Spam and Trash was an
 * allowlist of folder names that a typo could widen. Gmail's `X-GM-RAW` takes the same query
 * language as the Gmail search box, so there is one addressing scheme, no folder list to enumerate,
 * and the exclusion is part of the query itself.
 *
 * **`-in:spam -in:trash` is appended to every query and cannot be removed.** Not by a parameter,
 * not by `query`, not by an operator setting. `query` is passed through to Gmail so the agent gets
 * the real operator vocabulary, and a passthrough is exactly where an injected instruction in a
 * message body would try to reach — so the untrusted half is wrapped in parentheses and the
 * exclusions are appended outside them, where no amount of unbalanced quoting inside can escape.
 */
import type { MailQuery } from '../types.js';
import { TIMEZONE } from '../../../../../config.js';

/**
 * Appended to every query, always, outside any user-supplied grouping.
 *
 * Drafts are excluded alongside spam and trash, and that one is not about safety but about truth: a
 * draft lives in All Mail like everything else, so without this an unsent draft comes back from a
 * search as though it were a message that had arrived. Observed immediately — a draft written by
 * `create_draft` showed up as the newest *incoming* mail in the very next search.
 */
const EXCLUSIONS = '-in:spam -in:trash -in:drafts';

export class MailQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailQueryError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar arithmetic only; Gmail bounds are exact local-day epoch instants below. */
function shiftDay(day: string, deltaDays: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function validDay(day: string): void {
  if (!DAY.test(day) || shiftDay(day, 0) !== day)
    throw new MailQueryError(`Invalid calendar day: ${JSON.stringify(day)}`);
}

/** The first instant of a local calendar day, including 23/25-hour DST days. */
function dayBoundary(day: string, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDay = (seconds: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(seconds * 1000)).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const center = Date.parse(`${day}T00:00:00Z`) / 1000;
  let low = center - 172_800;
  let high = center + 172_800;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(middle) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function dateWindow(
  query: Pick<MailQuery, 'since' | 'until'>,
  timezone = TIMEZONE,
): { start?: number; end?: number } {
  if (query.since) validDay(query.since);
  if (query.until) validDay(query.until);
  if (query.since && query.until && query.since > query.until)
    throw new MailQueryError('since must not be after until');
  return {
    ...(query.since ? { start: dayBoundary(query.since, timezone) } : {}),
    ...(query.until ? { end: dayBoundary(shiftDay(query.until, 1), timezone) } : {}),
  };
}

/** Gmail treats a bare space as AND, so a multi-word value has to be quoted to stay one term. */
function term(operator: string, value: string): string {
  const cleaned = value.trim().replace(/"/g, '');
  if (!cleaned) return '';
  return /\s/.test(cleaned) ? `${operator}"${cleaned}"` : `${operator}${cleaned}`;
}

/**
 * Whether the caller already bounded the search in time.
 *
 * If they did, the recency window below must not be added on top — narrowing a range someone asked
 * for explicitly would return a subset of what they requested while looking like the whole answer.
 */
export function hasOwnDateBound(query: MailQuery): boolean {
  if (query.since || query.until) return true;
  return /\b(?:newer_than|older_than|after|before|newer|older):/i.test(query.query ?? '');
}

/**
 * Bound a query to the recent past.
 *
 * IMAP `SEARCH` has no server-side limit: it returns *every* matching UID, and the client picks
 * from them. On a real mailbox that is not a rounding error — this account holds 417,000 messages,
 * and an unfiltered search transferred all 417,000 ids, taking 5.6 seconds, to use fifteen of them.
 * The same search bounded to 30 days returns 30,000 in 1.5 seconds.
 *
 * So the first attempt is always windowed. It is *not* a cap: `searchThreads` re-runs the search
 * unbounded whenever the window did not produce enough threads, so mail older than the window is
 * still found — it just costs the slow path, and only when the fast one came up short.
 */
export function windowedQuery(query: MailQuery, days: number): string {
  return `${buildGmailQuery(query)} newer_than:${days}d`;
}

export function buildGmailQuery(query: MailQuery, timezone = TIMEZONE): string {
  const parts: string[] = [];

  if (query.from) parts.push(term('from:', query.from));
  if (query.to) parts.push(term('to:', query.to));
  if (query.subject) parts.push(term('subject:', query.subject));

  const window = dateWindow(query, timezone);
  // Fetch the inclusive lower boundary regardless of Gmail's after equality behavior;
  // the backend checks each returned internal timestamp against the exact interval.
  if (window.start !== undefined) parts.push(`after:${window.start - 1}`);
  if (window.end !== undefined) parts.push(`before:${window.end}`);

  if (query.direction === 'outgoing') parts.push('in:sent');
  else if (query.direction === 'incoming') parts.push('-in:sent');

  if (query.unreadOnly) parts.push('is:unread');
  if (query.hasAttachment) parts.push('has:attachment');

  // Parenthesized so the passthrough cannot terminate the query and append operators of its own.
  const passthrough = query.query?.trim();
  if (passthrough) parts.push(`(${passthrough})`);

  const built = parts.filter(Boolean).join(' ');
  return built ? `${built} ${EXCLUSIONS}` : EXCLUSIONS;
}
