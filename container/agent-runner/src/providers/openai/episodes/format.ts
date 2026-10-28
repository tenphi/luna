/**
 * Shared formatting for episodes: relative dates, title/emoji sanitizing, and
 * history excerpts. Used by the classifier prompt, the topic divider, the
 * `<recent-conversations>` block, and the summarizer.
 */
import type { ChatMessage } from '../types.js';

export const DEFAULT_EMOJI = '💬';

/** Name of an episode opened before anything was said in it (the `/clear` path). */
export const UNTITLED_TOPIC = 'New topic';

const MAX_TITLE_CHARS = 60;
const MAX_TITLE_WORDS = 9;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One emoji, including variation selectors, ZWJ sequences, and keycaps. */
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*|[0-9#*]\uFE0F?\u20E3)/u;

/** Openers we strip when naming a topic from the user's own words. */
const TITLE_NOISE_RE =
  /^(?:ok(?:ay)?|so|now|hey|hi|hello|please|new topic[:,-]?|another topic[:,-]?|different topic[:,-]?|let'?s|lets|can you|could you|i (?:need|want|would like) (?:you )?to)\s+/i;

/** A link is never a topic name — but its host is a usable last resort. */
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

/** Punctuation that only made sense while the link it introduced was there. */
const DANGLING_RE = /^[\s\-–—:;,.·|/\\]+|[\s\-–—:;,.·|/\\]+$/g;

/**
 * Slice to `max` characters without cutting an emoji in half. A trailing lone
 * surrogate is invalid UTF-16, and an endpoint that parses the request as JSON
 * rejects the whole call over it.
 */
export function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function urlHost(url: string): string {
  return (
    url
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#]/)[0] ?? ''
  );
}

/**
 * Strip links out of a candidate title, keeping the first host so a message
 * that is nothing but a URL still gets a name.
 */
function stripUrls(text: string): { text: string; host: string } {
  const hosts = text.match(URL_RE)?.map(urlHost).filter(Boolean) ?? [];
  const stripped = text.replace(URL_RE, ' ').replace(/\s+/g, ' ').replace(DANGLING_RE, '');
  return { text: stripped, host: hosts[0] ?? '' };
}

/**
 * Word cap first, character cap second, both on a boundary. A title cut inside
 * a token ("…/products/flig") reads as a bug; an ellipsis reads as a title.
 */
function clipTitle(title: string): string {
  const words = title.split(' ');
  let out = words.slice(0, MAX_TITLE_WORDS).join(' ');
  let clipped = words.length > MAX_TITLE_WORDS;

  if (out.length > MAX_TITLE_CHARS) {
    const cut = out.slice(0, MAX_TITLE_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    out = lastSpace > MAX_TITLE_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
    clipped = true;
  }

  out = out.replace(DANGLING_RE, '');
  return clipped && out ? `${out}…` : out;
}

/**
 * Whole calendar days from `then` to `now`, by local date rather than elapsed ms
 * so 11pm → 1am reads as one day and not as zero. Exported for `auto-timeline`,
 * which needs the same day arithmetic but not `relativeWhen`'s sub-day branches.
 */
export function calendarDaysBetween(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * Human relative time — "just now", "12m ago", "3h ago", "yesterday",
 * "Friday", "Jul 12". Resolving "the task we discussed yesterday" is the whole
 * reason the injected block carries these.
 */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'earlier';
  const ms = now.getTime() - then.getTime();
  if (ms < 60_000) return 'just now';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const days = calendarDaysBetween(then, now);
  if (days <= 0) return `${Math.floor(minutes / 60)}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return WEEKDAYS[then.getDay()] ?? 'earlier';
  if (then.getFullYear() === now.getFullYear()) return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.toISOString().slice(0, 10);
}

export function sanitizeTitle(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  let title = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  // A model that ignored the schema and answered with the decision instead.
  if (/^(continue|new|resume)$/i.test(title)) return fallback;

  // Small models echo the message back, links and all.
  const { text, host } = stripUrls(title);
  title = clipTitle(text || host);

  if (title.length < 2) return fallback;
  return title;
}

export function sanitizeEmoji(raw: unknown, fallback: string = DEFAULT_EMOJI): string {
  if (typeof raw !== 'string') return fallback;
  return EMOJI_RE.exec(raw.trim())?.[0] ?? fallback;
}

/**
 * Name a topic from the user's own words. Used for the first episode of a
 * session and for explicit-cue switches, neither of which spends a model call;
 * the background summarizer replaces it with a real title at close.
 */
export function deterministicTitle(userText: string): string {
  // Line first, then sentence: a second line is a second thought, not a
  // continuation of the first clause.
  const firstLine = userText.split(/[\r\n]+/).find((line) => line.trim().length > 0) ?? '';
  const firstClause = firstLine.split(/(?<=[.!?;])\s|—|--/)[0] ?? '';
  const cleaned = firstClause.replace(TITLE_NOISE_RE, '').replace(/\s+/g, ' ').trim();
  const title = sanitizeTitle(cleaned, '');
  if (!title) return UNTITLED_TOPIC;
  // A message that was only a link falls back to its host, which is a name
  // already — "Example.test" reads worse than "example.test".
  if (/^\S+\.[a-z]{2,}$/i.test(title)) return title;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function plainText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? part.text : '[image]'))
      .join(' ');
  }
  return '';
}

/**
 * Blocks that carry the `user` role without anyone having said them: recall,
 * agendas, archived summaries, and non-chat wake-ups (tasks, webhooks, MCP
 * responses). None of them are conversation.
 */
const INJECTED_TAG_RE =
  /^<(?:calendar-agenda|reminders-agenda|conversation_summary|memory|memory_evidence|memory-structure|hot-memory|recent-conversations|timeline|task|webhook|system_response)\b/;

/**
 * The formatter opens *every* prompt with this, injected block or not
 * (`formatMessages` in formatter.ts), so a task wake-up reaches history as
 * `<context …/>\n<task …>`. Matching the tag without stripping it first filed
 * scheduled reminders as conversation: they counted as user turns, and the
 * classifier read a raw XML block as the current topic's last exchange.
 */
const CONTEXT_HEADER_RE = /^<context\b[^>]*\/>\s*/;

/**
 * The label `drainPendingViewImages` pushes after the model looks at a memory
 * file. Same category as the tags above — a `user` message nobody wrote.
 */
const VIEWED_LABEL_RE = /^\[Viewed from memory:/;

const MESSAGE_BODY_RE = /<message\b[^>]*>([\s\S]*?)<\/message>/g;

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function isInjectedBlock(text: string): boolean {
  const body = text.trimStart().replace(CONTEXT_HEADER_RE, '');
  return INJECTED_TAG_RE.test(body) || VIEWED_LABEL_RE.test(body);
}

/**
 * What the user actually said, from a history entry the formatter wrapped in
 * `<context …/>` + `<message …>` envelopes. Topic titles and summaries are read
 * by humans and models alike, so the markup has to come off first.
 */
export function unwrapUserText(text: string): string {
  const bodies = [...text.matchAll(MESSAGE_BODY_RE)].map((m) => unescapeXml(m[1] ?? '').trim());
  if (bodies.length > 0) return bodies.filter(Boolean).join('\n');
  return text.replace(/<context\b[^>]*\/>/g, '').trim();
}

/**
 * The formatter's own annotation for an attachment, e.g.
 * `[document: bill.pdf — saved to /workspace/inbox/m-42/bill.pdf]`.
 *
 * Machine text inside a message body, so `unwrapUserText` keeps it — correct for
 * a history excerpt, wrong for a topic title or a semantic recall query, where a
 * container path is pure noise. What the file actually *says* now arrives
 * separately as attachment evidence, so nothing is lost by dropping it.
 *
 * Deliberately not folded into `unwrapUserText`: `countUserTurns` gates on that
 * returning something, and a caption-less attachment is still a real user turn.
 */
const ATTACHMENT_ANNOTATION_RE =
  /\[(?:image|photo|sticker|animation|document|file|video|audio|voice|attachment)\s*:[^\]]*\]/gi;

export function stripAttachmentAnnotations(text: string): string {
  return text.replace(ATTACHMENT_ANNOTATION_RE, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/**
 * Comparable form of a message body: lowercase words, nothing else.
 *
 * Matching a quoted reply against a history file is a comparison between two
 * renderings of the same message. The platform hands back what the user *saw*
 * (`Play on Normal first`), history holds what the model wrote
 * (`**Play on Normal first**`), and a user message is stored XML-escaped. Words
 * are the only part all three agree on, so everything else goes.
 */
export function textSignature(text: string): string {
  return unescapeXml(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The formatter's rendering of a reply's quoted original, inside the user
 * message that replied to it. It is a pointer to a message said elsewhere, not
 * something said in this episode, so quote-matching has to skip it — otherwise
 * the episode that handled one reply answers for every later reply to the same
 * message.
 */
const QUOTED_BLOCK_RE = /<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/gi;

/**
 * Does this history contain the message the user quoted?
 *
 * Compared per message rather than over a joined haystack, so a needle can
 * never match across the seam between two unrelated messages. The needle is the
 * opening of the quote: a platform may truncate a long one, and an assistant
 * message can be split across several deliveries, so only the head is reliably
 * present in one stored message.
 */
export function historyContainsQuote(history: ChatMessage[], needle: string): boolean {
  if (!needle) return false;
  return history.some((msg) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') return false;
    const raw = plainText(msg.content);
    if (isInjectedBlock(raw)) return false;
    return textSignature(raw.replace(QUOTED_BLOCK_RE, ' ')).includes(needle);
  });
}

/**
 * Real user turns in a history. Drives the substance threshold that keeps
 * one-shot questions out of memory.
 */
export function countUserTurns(history: ChatMessage[]): number {
  return history.filter((msg) => {
    if (msg.role !== 'user') return false;
    const text = plainText(msg.content);
    return !isInjectedBlock(text) && unwrapUserText(text).length > 0;
  }).length;
}

/**
 * Last `turns` user/assistant exchanges as plain lines, each truncated. Tool
 * calls and results are skipped — topic identity lives in what was said.
 */
export function historyExcerpt(history: ChatMessage[], turns = 2, maxCharsPerLine = 240): string {
  const lines: string[] = [];
  let userTurns = 0;
  for (let i = history.length - 1; i >= 0 && userTurns < turns; i--) {
    const msg = history[i];
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const raw = plainText(msg.content);
    if (isInjectedBlock(raw)) continue;
    const text = (msg.role === 'user' ? unwrapUserText(raw) : raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.unshift(`${msg.role}: ${text.length > maxCharsPerLine ? `${clipChars(text, maxCharsPerLine)}…` : text}`);
    if (msg.role === 'user') userTurns++;
  }
  return lines.join('\n');
}

/**
 * The episode's conversation as plain `user:` / `assistant:` lines, oldest
 * first, for the summarizer and the provisional summary. Same filtering as
 * `historyExcerpt` without the turn limit.
 */
export function episodeTranscript(history: ChatMessage[], maxChars = 8_000, maxCharsPerLine = 400): string {
  const lines: string[] = [];
  for (const msg of history) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const raw = plainText(msg.content);
    if (isInjectedBlock(raw)) continue;
    const text = (msg.role === 'user' ? unwrapUserText(raw) : raw).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${msg.role}: ${text.length > maxCharsPerLine ? `${text.slice(0, maxCharsPerLine)}…` : text}`);
  }

  // Keep the tail: how an episode ended says more about it than how it opened.
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
    const firstBreak = out.indexOf('\n');
    out = firstBreak >= 0 ? out.slice(firstBreak + 1) : out;
  }
  return out;
}
