/**
 * Capping one body, and saying exactly how to get the rest.
 *
 * A truncation marker that only says "truncated" costs a turn: the agent knows something is missing
 * and has to guess at the call that recovers it. So the marker carries the call itself, with this
 * message's real id and the right offset already filled in — the agent copies it rather than
 * deriving it, and cannot derive it wrongly.
 *
 * The cut lands on a paragraph or line boundary when one is close enough, because a body sliced
 * mid-sentence reads as corrupt and invites a re-read that the budget was there to avoid.
 */

/** Never leave less than this fraction of the budget on the table chasing a clean break. */
const MIN_KEEP_RATIO = 0.8;

export interface BudgetResult {
  text: string;
  truncatedChars: number;
}

function niceCutPoint(text: string, limit: number): number {
  const floor = Math.floor(limit * MIN_KEEP_RATIO);
  const paragraph = text.lastIndexOf('\n\n', limit);
  if (paragraph >= floor) return paragraph;
  const line = text.lastIndexOf('\n', limit);
  if (line >= floor) return line;
  const sentence = text.lastIndexOf('. ', limit);
  if (sentence >= floor) return sentence + 1;
  const space = text.lastIndexOf(' ', limit);
  return space >= floor ? space : limit;
}

/**
 * Truncate `text` to `maxChars`, appending the call that continues it.
 *
 * `offset` is the offset this text already starts at, so continuing a continuation produces the
 * right next offset rather than always pointing back at the second page.
 */
export function budgetBody(text: string, maxChars: number, messageId: string, offset = 0): BudgetResult {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncatedChars: 0 };

  const cut = niceCutPoint(text, maxChars);
  const head = text.slice(0, cut).trimEnd();
  const truncatedChars = text.length - head.length;
  const nextOffset = offset + head.length;

  const marker =
    `\n\n[… ${truncatedChars.toLocaleString('en-US')} characters omitted — continue with ` +
    `read_message({ id: "${messageId}", offset: ${nextOffset} })]`;

  return { text: head + marker, truncatedChars };
}
