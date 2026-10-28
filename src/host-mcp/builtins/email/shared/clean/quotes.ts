/**
 * Cutting the thread back out of every message in the thread.
 *
 * Mail clients quote: each reply carries the entire conversation beneath it, so a twenty-message
 * thread read message-by-message contains the first message twenty times. `read_thread` returns
 * every message, which makes the redundancy quadratic — this is the single largest token saving in
 * the builtin, and on a long thread it is the difference between a few thousand tokens and a few
 * tens of thousands.
 *
 * **Nothing is dropped silently.** Every cut is counted and returned, because "this message is two
 * lines long" and "this message was trimmed to two lines" are different facts, and an agent that
 * cannot tell them apart will summarize an empty reply as if it were the whole answer. When the
 * count looks wrong, `read_message({ raw: true })` returns the original.
 */

export interface StripResult {
  text: string;
  quotedLines: number;
  signatureLines: number;
}

/**
 * The line that starts a quoted block.
 *
 * Attribution lines are localized and clients disagree on wording, so these match structure rather
 * than vocabulary: a date-ish preamble ending in `wrote:`, the Outlook separator, or the header
 * block Outlook emits instead. Kept conservative on purpose — over-matching truncates a real
 * message, which is worse than leaving a quote in.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  // "On Mon, 3 Feb 2026 at 14:02, Someone <a@b> wrote:" — possibly wrapped across two lines.
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*(?:Am|Le|El|Il|On)\b.{0,200}\b(?:schrieb|écrit|escribió|ha scritto):\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*From:\s*.+$/i,
];

/** `-- ` on its own line is the RFC 3676 signature separator; the looser forms are what clients emit. */
const SIGNATURE_PATTERNS: RegExp[] = [/^--\s?$/, /^__+$/, /^Sent from my \w+/i, /^Get Outlook for \w+/i];

/**
 * The Outlook header block only counts as a quote when it is actually a header block.
 *
 * `From:` alone is far too eager — plenty of real messages begin a line that way when someone is
 * quoting a name or writing a form. Requiring a `Sent:`/`Date:` or `To:` line within the next few
 * lines is what separates a quoted header from a sentence.
 */
function isOutlookHeaderBlock(lines: string[], index: number): boolean {
  if (!/^\s*From:\s*.+$/i.test(lines[index] ?? '')) return false;
  const window = lines.slice(index + 1, index + 5).join('\n');
  return /^\s*(?:Sent|Date|To):\s*.+$/im.test(window);
}

function isAttributionAt(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  for (const pattern of ATTRIBUTION_PATTERNS) {
    if (pattern === ATTRIBUTION_PATTERNS[ATTRIBUTION_PATTERNS.length - 1]) continue;
    if (pattern.test(line)) return true;
  }
  return isOutlookHeaderBlock(lines, index);
}

/**
 * An attribution can wrap: "On Mon, 3 Feb 2026 at 14:02," / "Someone <ada@example.test> wrote:". Neither
 * half matches alone, and missing it leaves the whole quoted thread in.
 */
function isWrappedAttributionAt(lines: string[], index: number): boolean {
  const first = lines[index] ?? '';
  if (!/^\s*On\b.{0,200},\s*$/i.test(first) && !/^\s*On\b[^:]{0,200}$/i.test(first)) return false;
  const next = lines[index + 1] ?? '';
  return /\bwrote:\s*$/i.test(next);
}

/**
 * Where the quoted material begins, or -1.
 *
 * A run of `>`-prefixed lines only counts once it reaches the end of the message — a single `>`
 * line in the middle is someone quoting a phrase inline, which is content.
 */
function quoteStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (isAttributionAt(lines, i) || isWrappedAttributionAt(lines, i)) return i;

    if (/^\s*>/.test(lines[i] ?? '')) {
      const restIsQuoted = lines.slice(i).every((line) => /^\s*>/.test(line) || line.trim() === '');
      if (restIsQuoted) return i;
    }
  }
  return -1;
}

function signatureStartIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!SIGNATURE_PATTERNS.some((p) => p.test(line))) continue;
    // A signature is the tail. A `--` ten lines from the end of a forty-line message is a rule in
    // the prose, and cutting there would take real content with it.
    if (lines.length - i <= 12) return i;
  }
  return -1;
}

/** Strip quoted history and the signature, reporting exactly how many lines each took. */
export function stripQuotes(body: string): StripResult {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  const quoteAt = quoteStartIndex(lines);
  const kept = quoteAt >= 0 ? lines.slice(0, quoteAt) : lines;
  const quotedLines = quoteAt >= 0 ? lines.length - quoteAt : 0;

  const signatureAt = signatureStartIndex(kept);
  const body2 = signatureAt >= 0 ? kept.slice(0, signatureAt) : kept;
  const signatureLines = signatureAt >= 0 ? kept.length - signatureAt : 0;

  return {
    text: body2
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    quotedLines,
    signatureLines,
  };
}
