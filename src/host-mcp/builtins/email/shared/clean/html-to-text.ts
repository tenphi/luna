/**
 * HTML mail to something worth spending tokens on.
 *
 * Not a general-purpose converter, and deliberately not a dependency. Mail HTML is a narrow, ugly
 * dialect — nested layout tables, tracking pixels, inlined styles, a `<div class="gmail_quote">`
 * holding the entire thread again — and a general converter faithfully renders all of it. The job
 * here is the opposite of faithful: keep the sentences and the links, drop everything that exists
 * for a mail client's benefit rather than a reader's.
 *
 * Links are kept as `text (url)` rather than dropped, because "click here" with the URL removed is
 * the one transformation that can make an agent answer a question wrongly rather than incompletely.
 */

const BLOCK_TAGS =
  /<\/?(?:address|article|aside|blockquote|br|div|dd|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

/** Elements whose *contents* are not prose and must go with them. */
const DROPPED_ELEMENTS = /<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Gmail, Outlook and Apple Mail each wrap the quoted thread in a container of their own. Dropping
 * them here rather than in the quote stripper matters: by the time HTML is flattened to text the
 * nesting is gone, and a quoted chain that was one `<blockquote>` becomes indistinguishable from
 * the message a reply was actually written in.
 */
const QUOTE_CONTAINERS = [
  /<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi,
  /<div\b[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*$/i,
  /<div\b[^>]*(?:id|class)="[^"]*(?:appendonsend|divRplyFwdMsg)[^"]*"[^>]*>[\s\S]*$/i,
];

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '\u200c',
  zwj: '\u200d',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  euro: '€',
  pound: '£',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `<a href="…">text</a>` → `text (url)`, dropping the parens when the text already is the url. */
function unwrapLinks(html: string): string {
  return html.replace(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, inner: string) => {
      const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
      const url = decodeEntities(href).trim();
      // Tracking pixels and unsubscribe beacons wrapped around whitespace: nothing to keep.
      if (!text && !url) return '';
      if (!text) return url;
      if (!url || url.startsWith('#') || url.startsWith('mailto:') || text === url) return text;
      return `${text} (${url})`;
    },
  );
}

export interface HtmlToTextResult {
  text: string;
  /** True when a quote container was dropped, so the caller can count it as quoting rather than loss. */
  droppedQuoteContainer: boolean;
}

export function htmlToText(html: string): HtmlToTextResult {
  let out = html;
  let droppedQuoteContainer = false;

  out = out.replace(DROPPED_ELEMENTS, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');

  for (const pattern of QUOTE_CONTAINERS) {
    if (pattern.test(out)) {
      droppedQuoteContainer = true;
      out = out.replace(pattern, ' ');
    }
    pattern.lastIndex = 0;
  }

  // An <img> is either decorative, a tracking pixel, or content the agent cannot see anyway. Alt
  // text is the only part with information in it, and only when someone bothered to write one.
  out = out.replace(/<img\b[^>]*alt\s*=\s*(["'])(.*?)\1[^>]*>/gi, (_match, _quote: string, alt: string) =>
    alt.trim() ? ` [image: ${alt.trim()}] ` : ' ',
  );
  out = out.replace(/<img\b[^>]*>/gi, ' ');

  out = unwrapLinks(out);
  out = out.replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n\n');
  out = out.replace(BLOCK_TAGS, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeEntities(out);

  return { text: collapseWhitespace(out), droppedQuoteContainer };
}

/**
 * Whitespace normalization that survives layout tables.
 *
 * Table-based mail arrives as hundreds of cells each contributing a newline, so a plain trim leaves
 * a page of blank lines between two sentences. Runs of blank lines collapse to one, and trailing
 * spaces go — but a single newline is preserved, because in plain-text mail it is often the only
 * thing separating list items.
 */
export function collapseWhitespace(input: string): string {
  return (
    input
      .replace(/\r\n?/g, '\n')
      // Email preview padding is a whole otherwise empty line. Joiners inside prose remain intact.
      .replace(/^(?:[ \t\u00a0]|\u200b|\u200c|\u200d|\ufeff){8,}$/gm, '')
      // Written as an escape: a literal non-breaking space is invisible in a diff and in review.
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
