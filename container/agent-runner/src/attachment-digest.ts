/**
 * The attachment intake stage: read what the user just sent, before deciding
 * anything about the turn.
 *
 * The failure this exists for: a single Telegram message carrying a PDF and no
 * caption. `extractUserText` returns `''`, the topic classifier gets a clipped
 * XML envelope naming a file, and the turn stays on whatever the conversation
 * was about a minute ago. Meanwhile the agent is told to run `pdftotext` itself
 * — two model round-trips *after* the topic decision has already gone wrong.
 *
 * So the runtime reads the file first, and one digest feeds four consumers:
 *
 *   - `freeGate` — so a caption-less attachment can never short-circuit to
 *     `continue`, and the envelope never leaks into a topic title
 *   - the topic classifier — real content instead of a filename
 *   - the auto-recall query — merchant and amount instead of markup
 *   - the agent's own prompt — an `<attachments>` block, so it has the text
 *     without shelling out
 *
 * Everything degrades. A missing binary, a dead endpoint, a corrupt file, or a
 * blown deadline all produce a thinner digest, never an exception: the invariant
 * is that the topic decision must never end up *worse* than it was before this
 * stage existed.
 */
import path from 'path';

import { readCached, writeCached, cacheKey, type AttachmentDigest } from './attachment-cache.js';
import { extractText, extractorFor, looksLikeRealText, pdfPageCount, renderPdfPages } from './doc-extract.js';
import { collectStagedAttachments, type StagedAttachment } from './image-attachments.js';
import type { MessageInRow } from './db/messages-in.js';
import { clipChars } from './providers/openai/episodes/format.js';
import { memoryChat } from './providers/openai/episodes/memory-model.js';

/** Tunables from `agent.context.attachments`. */
export interface AttachmentsConfig {
  enabled?: boolean;
  deadlineMs?: number;
  maxCharsPerAttachment?: number;
  maxBlockChars?: number;
  maxGistChars?: number;
  maxPdfPages?: number;
  ocrImages?: boolean;
  describeImages?: boolean;
}

export interface ResolvedAttachmentsConfig {
  enabled: boolean;
  deadlineMs: number;
  maxCharsPerAttachment: number;
  maxBlockChars: number;
  maxGistChars: number;
  maxPdfPages: number;
  ocrImages: boolean;
  describeImages: boolean;
}

export function resolveAttachmentsConfig(raw?: AttachmentsConfig): ResolvedAttachmentsConfig {
  return {
    enabled: raw?.enabled !== false,
    deadlineMs: positive(raw?.deadlineMs, 20_000),
    maxCharsPerAttachment: positive(raw?.maxCharsPerAttachment, 4_000),
    maxBlockChars: positive(raw?.maxBlockChars, 12_000),
    maxGistChars: positive(raw?.maxGistChars, 600),
    maxPdfPages: positive(raw?.maxPdfPages, 20),
    ocrImages: raw?.ocrImages !== false,
    describeImages: raw?.describeImages !== false,
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * What the topic decision and the recall query get. Deliberately small — the
 * full text stays in the prompt block and the `.txt` sidecar.
 */
export interface AttachmentEvidence {
  count: number;
  imageCount: number;
  documentCount: number;
  /** One clipped clause per file, for the classifier and the recall query. */
  gist: string;
  /** Deterministic topic-title candidate, from the filename. Never model output. */
  titleHint: string;
}

export interface AttachmentIntake {
  /** `<attachments>` XML for the agent's prompt. Empty when there is nothing to say. */
  block: string;
  evidence: AttachmentEvidence;
}

export const EMPTY_INTAKE: AttachmentIntake = {
  block: '',
  evidence: { count: 0, imageCount: 0, documentCount: 0, gist: '', titleHint: '' },
};

/** How many pages of a text-less PDF are worth rasterizing for a vision read. */
const INTAKE_RENDER_PAGES = 2;
/** Concurrent digests. The subprocesses share the host's CPU with everything else. */
const CONCURRENCY = 3;
const PER_TOOL_TIMEOUT_MS = 15_000;
const DESCRIBE_TIMEOUT_MS = 12_000;
/** Enough for a useful description, short enough not to become the turn. */
const DESCRIBE_MAX_TOKENS = 400;

const DESCRIBE_SYSTEM = `You are reading a file someone just sent in a chat, so an assistant knows what it is.

Reply with 2-4 sentences of plain prose. Lead with what the document or picture IS ("a water utility's annual bill","a photo of a restaurant menu", "a screenshot of a stack trace"). Then the details that identify this specific one: names, amounts, dates, reference numbers, addresses, what the error says.

Describe only what you can actually see. Never guess at a total, a date, or a name you cannot read, and never ask a question or offer help — nobody reads this but the assistant.

Write the description in English even when the file is in another language. Names, official titles, reference numbers and amounts stay exactly as printed; the prose around them is English.`;

function log(msg: string): void {
  console.error(`[attachments] ${msg}`);
}

export interface IntakeDeps {
  /** Injectable for tests; defaults to the runtime extractor. */
  extract?: typeof extractText;
  render?: typeof renderPdfPages;
  pageCount?: typeof pdfPageCount;
  /** Injectable model call for the description pass. */
  chat?: typeof memoryChat;
  now?: () => number;
}

/**
 * Digest every attachment on a batch.
 *
 * Returns {@link EMPTY_INTAKE} — cheaply, with no I/O at all — when the batch
 * carries no attachments, which is the overwhelming majority of turns. This
 * stage only costs anything when there is something to read.
 */
export async function runAttachmentIntake(
  messages: MessageInRow[],
  config: ResolvedAttachmentsConfig,
  deps: IntakeDeps = {},
): Promise<AttachmentIntake> {
  if (!config.enabled) return EMPTY_INTAKE;

  const staged = collectStagedAttachments(messages);
  if (staged.length === 0) return EMPTY_INTAKE;

  const started = (deps.now ?? Date.now)();
  const deadline = started + config.deadlineMs;

  const digests = await mapWithLimit(staged, CONCURRENCY, (att) =>
    digestOne(att, config, deps, deadline).catch((err) => {
      // A digest is a nicety. Report the file, not the exception.
      log(`Digest failed for ${att.name}: ${err instanceof Error ? err.message : String(err)}`);
      return fallbackDigest(att, 'digest failed');
    }),
  );

  const elapsed = (deps.now ?? Date.now)() - started;
  log(`Digested ${digests.length} attachment(s) in ${elapsed}ms`);

  return { block: renderBlock(digests, config), evidence: buildEvidence(staged, digests, config) };
}

// --- One file -------------------------------------------------------------

async function digestOne(
  att: StagedAttachment,
  config: ResolvedAttachmentsConfig,
  deps: IntakeDeps,
  deadline: number,
): Promise<AttachmentDigest> {
  const key = cacheKey(att.localPath, att.bytes, att.path);
  const cached = readCached(key);
  if (cached) return cached;

  const extract = deps.extract ?? extractText;
  const render = deps.render ?? renderPdfPages;
  const pageCount = deps.pageCount ?? pdfPageCount;

  const base: AttachmentDigest = {
    name: att.name,
    mimeType: att.mimeType,
    bytes: att.bytes,
    isImage: att.isImage,
    text: null,
    tool: null,
  };

  const kind = extractorFor(att.name, att.mimeType);
  if (!kind) {
    return writeCached(key, { ...base, failure: 'no extractor for this file type' });
  }
  // OCR is the only extractor an operator may want off — it is the CPU-hungry
  // one, and the one whose output most often needs the quality gate below.
  if (kind === 'ocr' && !config.ocrImages) {
    return writeCached(key, { ...base, failure: 'image OCR is disabled' });
  }

  const timeoutMs = Math.max(1_000, Math.min(PER_TOOL_TIMEOUT_MS, deadline - Date.now()));
  const extracted = await extract(att.path, att.name, att.mimeType, {
    maxPages: config.maxPdfPages,
    timeoutMs,
  });

  const pages = kind === 'pdf' ? (await pageCount(att.path, { timeoutMs: 5_000 })) ?? undefined : undefined;

  // OCR output is machine noise as often as it is text; extraction from a real
  // text layer is not. Only the noisy source gets gated.
  if (extracted && (kind !== 'ocr' || looksLikeRealText(extracted.text))) {
    const clipped = clipChars(extracted.text, config.maxCharsPerAttachment);
    return writeCached(
      key,
      {
        ...base,
        text: clipped,
        tool: extracted.tool,
        truncated: clipped.length < extracted.text.length,
        pages,
      },
      extracted.text,
    );
  }

  // No usable text. For an image, or a PDF with no text layer (a scan), the
  // bytes still say something — but only a model can read them.
  if (!config.describeImages) {
    return writeCached(key, { ...base, pages, failure: describeSkippedReason(kind) });
  }
  if (Date.now() >= deadline) {
    return writeCached(key, { ...base, pages, failure: 'ran out of time before it could be read' });
  }

  const images =
    kind === 'ocr'
      ? [{ path: att.path, mimeType: att.mimeType ?? 'image/jpeg' }]
      : kind === 'pdf'
        ? (await render(att.path, path.dirname(att.path), INTAKE_RENDER_PAGES, { timeoutMs })).map((p) => ({
            path: p,
            mimeType: 'image/png',
          }))
        : [];

  if (images.length === 0) {
    return writeCached(key, { ...base, pages, failure: describeSkippedReason(kind) });
  }

  const described = await describe(att, images, deps);
  if (!described) {
    return writeCached(key, { ...base, pages, failure: 'could not be read' });
  }
  const clippedDescription = clipChars(described, config.maxCharsPerAttachment);
  return writeCached(
    key,
    {
      ...base,
      text: clippedDescription,
      tool: 'vision',
      described: true,
      truncated: clippedDescription.length < described.length,
      pages,
    },
    described,
  );
}

function describeSkippedReason(kind: string): string {
  return kind === 'pdf' ? 'no text layer (scanned) and not read' : 'no readable text';
}

/**
 * One model call describing the file. Runs on the memory model — a separate
 * stream from the main agent, so the digest never becomes part of the turn's
 * reasoning and never spends main-model tokens once `models.memory` is set.
 */
async function describe(
  att: StagedAttachment,
  images: { path: string; mimeType: string }[],
  deps: IntakeDeps,
): Promise<string | null> {
  const chat = deps.chat ?? memoryChat;
  const label = att.isImage ? 'image' : `file "${att.name}"`;
  const text = await chat(
    [
      { role: 'system', content: DESCRIBE_SYSTEM },
      { role: 'user', content: `Describe this ${label}.` },
    ],
    {
      images,
      maxTokens: DESCRIBE_MAX_TOKENS,
      temperature: 0,
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
    },
  );
  return text?.trim() || null;
}

function fallbackDigest(att: StagedAttachment, failure: string): AttachmentDigest {
  return {
    name: att.name,
    mimeType: att.mimeType,
    bytes: att.bytes,
    isImage: att.isImage,
    text: null,
    tool: null,
    failure,
  };
}

// --- Rendering ------------------------------------------------------------

/**
 * The `<attachments>` block spliced into the agent's prompt.
 *
 * Every digest is attacker-supplied text — anyone who can DM the bot controls
 * it — so it is XML-delimited, `</attachment>` lookalikes are neutralized, and
 * it never goes anywhere near a system message.
 */
function renderBlock(digests: AttachmentDigest[], config: ResolvedAttachmentsConfig): string {
  if (digests.length === 0) return '';

  const parts: string[] = [
    '<attachments>',
    'Already read for you by the runtime — do not run pdftotext, tesseract, or pandoc on these.',
    'Use exact source text for document-specific facts. A Description or clipped excerpt is only a pointer; open the full text before asserting a field or using it in an external action. Leave missing fields unresolved.',
  ];
  let budget = config.maxBlockChars;

  for (const d of digests) {
    const attrs = [
      `name="${escapeAttr(d.name)}"`,
      d.mimeType ? `type="${escapeAttr(d.mimeType)}"` : '',
      d.pages ? `pages="${d.pages}"` : '',
      d.tool ? `read_by="${escapeAttr(d.tool)}"` : '',
      d.textPath ? `full_text="${escapeAttr(d.textPath)}"` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const body = d.text
      ? bodyFor(d, Math.max(0, Math.min(config.maxCharsPerAttachment, budget)))
      : `[${d.failure ?? 'could not be read'}]`;
    budget -= body.length;

    parts.push(`<attachment ${attrs}>`, body, '</attachment>');
    if (budget <= 0) {
      const remaining = digests.length - digests.indexOf(d) - 1;
      if (remaining > 0) parts.push(`[${remaining} more attachment(s) omitted — the block hit its size limit]`);
      break;
    }
  }

  parts.push('</attachments>');
  return parts.join('\n');
}

function bodyFor(d: AttachmentDigest, limit: number): string {
  const text = neutralize(d.text ?? '');
  const clipped = clipChars(text, limit);
  const prefix = d.described ? 'Description: ' : '';
  // Either the whole-block budget cut it here, or extraction already cut it
  // when the digest was stored.
  if (clipped.length < text.length || d.truncated) {
    const tail = d.textPath
      ? `\n[clipped — the full text is at ${d.textPath}]`
      : '\n[clipped — call extract_document for the rest]';
    return prefix + clipped + tail;
  }
  return prefix + clipped;
}

/**
 * Keep extracted content from closing its own envelope, and strip the control
 * characters `pdftotext` leaves behind — form feeds between pages, mostly.
 */
function neutralize(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
      .replace(/<(\/?)attachments?\b/gi, '\u2039$1attachment')
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Evidence -------------------------------------------------------------

function buildEvidence(
  staged: StagedAttachment[],
  digests: AttachmentDigest[],
  config: ResolvedAttachmentsConfig,
): AttachmentEvidence {
  const clauses: string[] = [];
  let budget = config.maxGistChars;
  const perFile = Math.max(80, Math.floor(config.maxGistChars / Math.max(1, digests.length)));

  for (const d of digests) {
    const label = d.name;
    const summary = d.text
      ? clipChars(neutralize(d.text).replace(/\s+/g, ' ').trim(), Math.min(perFile, budget))
      : `(${d.failure ?? 'unreadable'})`;
    const clause = `${label}: ${summary}`;
    budget -= clause.length;
    clauses.push(clause);
    if (budget <= 0) break;
  }

  return {
    count: staged.length,
    imageCount: staged.filter((a) => a.isImage).length,
    documentCount: staged.filter((a) => !a.isImage).length,
    gist: clauses.join('\n'),
    titleHint: titleFromFilename(staged[0]?.name ?? ''),
  };
}

/**
 * A topic title from a filename.
 *
 * Deterministic on purpose: a title is user-visible in the owner's topic
 * divider, and "Vulpine Mutual invoice 00412" beats both a line of OCR and the
 * `<context timezone="…"/>` fragment the envelope fallback used to produce. A
 * channel-generated name (`attachment-1753…`, `IMG_4021`) carries nothing, so it
 * yields an empty hint and the caller falls back to its own default.
 */
export function titleFromFilename(name: string): string {
  if (!name) return '';
  const stem = path.basename(name, path.extname(name));
  if (/^(attachment|img|image|photo|screenshot|scan|doc|document|file)[-_]?\d*$/i.test(stem)) return '';

  const words = stem
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A bare id (`000412`) names nothing a person would recognize.
  if (!words || !/[a-z]{3}/i.test(words)) return '';
  return clipChars(words.charAt(0).toUpperCase() + words.slice(1), 60);
}

// --- Concurrency ----------------------------------------------------------

/** `Promise.all` with a ceiling, so five PDFs don't spawn five pdftotexts at once. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
