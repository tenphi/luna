/**
 * `extract_document` — the agent-facing fallback for reading a file.
 *
 * Inbound attachments are already read before the turn starts (see
 * `attachment-digest.ts`), so this exists for the cases that pre-read cannot
 * cover: a file the agent downloaded itself, a document already stored in the
 * memory, or an attachment whose `<attachments>` entry says the text was clipped
 * and the agent needs the rest.
 *
 * It is a separate tool rather than another `manage_memory_file` action for
 * three reasons: that tool is gated on memory being wired, and reading
 * an inbox file has nothing to do with memory; its id vocabulary is `memory:`
 * only, while this needs container paths too; and its `get` returns text with no
 * `.txt` sidecar, which is the thing an agent filing a long document actually
 * needs — the page body carries a readable writeup, the sidecar carries the
 * verbatim text.
 */
import fs from 'fs';
import path from 'path';

import { readCached, writeCached, cacheKey } from '../../../attachment-cache.js';
import { extractText, extractorFor, pdfPageCount, renderPdfPages } from '../../../doc-extract.js';
import type { ImageAttachment } from '../../../image-attachments.js';
import { assertKbBlocked, type OpenAITool } from './builtin.js';

/**
 * Text for the tool result, plus any page images to drain separately — an image cannot ride
 * on a `role: 'tool'` message, which must immediately follow the assistant's `tool_calls`.
 */
export interface DocumentToolResult {
  text: string;
  images?: ImageAttachment[];
}
import {
  derivedDirFor,
  fileSize,
  formatBytes,
  isViewableImage,
  maxViewImages,
  mimeFor,
  renderDirFor,
  resolveMemoryFile,
  resolveSourcePath,
  stageMemoryFileCopy,
  MEMORY_URI_PREFIX,
} from './memory-files.js';

export const EXTRACT_DOCUMENT = 'extract_document';

/** Enough text for the model to work from; the rest is a file path away. */
const MAX_RESULT_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

export const extractDocumentSchema: OpenAITool = {
  type: 'function',
  function: {
    name: EXTRACT_DOCUMENT,
    description:
      'Read the text out of a PDF, Word/OpenDocument file, or scanned image. ' +
      'Files the user just attached are ALREADY read for you in the <attachments> block, and a document ' +
      'already in memory was read when it was filed — `memory_read {document}` returns that text with no ' +
      'extraction. Only call this when the <attachments> block says the text was clipped, or for a file you ' +
      'downloaded or generated yourself. Returns the extracted text plus the path to a .txt holding the ' +
      'complete text, for searching or quoting past the clip. A scanned PDF with no text layer is shown to ' +
      'you as rendered pages instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Container path, e.g. "/workspace/agent/downloads/contract.pdf". Not for knowledge-base files.',
        },
        memory: {
          type: 'string',
          description: `Stored file id instead, e.g. "${MEMORY_URI_PREFIX}personal/passport-ada.pdf".`,
        },
        pages: { type: 'number', description: 'PDF page cap (default 20).' },
      },
    },
  },
};

export function documentToolSchemas(): OpenAITool[] {
  return [extractDocumentSchema];
}

export function isDocumentTool(name: string): boolean {
  return name === EXTRACT_DOCUMENT;
}

export async function callDocumentTool(name: string, args: Record<string, unknown>): Promise<DocumentToolResult> {
  if (name !== EXTRACT_DOCUMENT) return { text: `Error: unknown tool ${name}.` };
  return extractDocument(args);
}

interface Target {
  /** Path to read. For a memory file this is a read-only copy, never the original. */
  abs: string;
  /** How the agent named it, echoed back so the result is self-identifying. */
  id: string;
  name: string;
  /** Cache identity, shared with the intake stage where one exists. */
  key: string | null;
  /**
   * Identity for derived-artifact dirs. Distinct from {@link key}, which is
   * nullable and shared with the intake cache — this one is always usable and
   * keeps two same-named sources' renders and sidecars apart.
   */
  token: string;
}

async function extractDocument(args: Record<string, unknown>): Promise<DocumentToolResult> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  const rawMemory = typeof args.memory === 'string' ? args.memory.trim() : '';

  if (rawPath && rawMemory) {
    return { text: 'Error: pass either `path` or `memory`, not both.' };
  }
  if (!rawPath && !rawMemory) {
    return {
      text:
        'Error: pass `path` (a container path) or `memory` (a stored file id). ' +
        'Files the user just attached are already read for you in the <attachments> block.',
    };
  }

  const target = rawMemory ? resolveMemoryTarget(rawMemory) : resolveContainerTarget(rawPath);
  if (typeof target === 'string') return { text: target };

  const maxPages = typeof args.pages === 'number' && args.pages > 0 ? Math.floor(args.pages) : 20;
  const mime = mimeFor(target.name);

  if (!extractorFor(target.name, mime)) {
    return {
      text:
        `${target.id} (${mime}, ${formatBytes(fileSize(target.abs))}) — nothing in this container can read that ` +
        'format. PDFs, Word/OpenDocument files, plain text, and images are supported.',
    };
  }

  // Share the intake's cache, so extracting an inbox file the runtime already
  // digested is free.
  const cached = target.key ? readCached(target.key) : null;
  const cachedText = cached?.textPath ? readIfExists(cached.textPath) : null;
  if (cached && cachedText) {
    const text = renderResult(target, mime, cachedText, cached.tool ?? 'cache', cached.pages, cached.textPath);
    if (isViewableImage(target.name)) {
      return { text, images: [{ path: target.abs, mimeType: mime, label: target.id }] };
    }
    return { text };
  }

  const extracted = await extractText(target.abs, target.name, mime, { maxPages, timeoutMs: TIMEOUT_MS });
  const pages =
    mime === 'application/pdf' ? ((await pdfPageCount(target.abs, { timeoutMs: 5_000 })) ?? undefined) : undefined;

  if (extracted) {
    const stored = target.key
      ? writeCached(
          target.key,
          {
            name: target.name,
            mimeType: mime,
            bytes: fileSize(target.abs),
            isImage: mime.startsWith('image/'),
            text: extracted.text.slice(0, MAX_RESULT_CHARS),
            tool: extracted.tool,
            truncated: extracted.text.length > MAX_RESULT_CHARS,
            pages,
          },
          extracted.text,
        )
      : null;
    const textPath = stored?.textPath ?? writeSidecar(target.token, target.name, extracted.text);
    const text = renderResult(target, mime, extracted.text, extracted.tool, pages, textPath);
    // An image's OCR text is a claim *about* bytes the agent has never seen. It
    // is also the only pre-store check available for a file the agent generated
    // itself, so hand back the picture next to the text rather than text alone:
    // two crops meant to be two different people, both reading the same name, is
    // only obvious when you can see them.
    if (isViewableImage(target.name)) {
      return { text, images: [{ path: target.abs, mimeType: mime, label: target.id }] };
    }
    return { text };
  }

  // No text layer. A scan is exactly where OCR reads worst, so show the pages.
  if (mime === 'application/pdf') {
    const rendered = await renderPdfPages(target.abs, renderDirFor(target.token), maxViewImages(), {
      timeoutMs: TIMEOUT_MS,
    });
    if (rendered.length > 0) {
      const images: ImageAttachment[] = rendered.map((p, i) => ({
        path: p,
        mimeType: 'image/png',
        label: `${target.id} page ${i + 1}`,
      }));
      return {
        text:
          `${target.id} (${mime}, ${formatBytes(fileSize(target.abs))}${pages ? `, ${pages} pages` : ''})\n` +
          `No text layer — this is a scan. Rendering the first ${rendered.length} page(s) for you to read below.`,
        images,
      };
    }
  }

  // An image OCR found nothing in is still worth looking at — a photo of a card,
  // a diagram, a crop with no legible text. Guessing is only forced when there
  // is neither text nor a picture.
  if (isViewableImage(target.name)) {
    return {
      text:
        `${target.id} (${mime}, ${formatBytes(fileSize(target.abs))}) — no readable text. ` +
        'The image is shown to you below; describe only what you can actually see in it.',
      images: [{ path: target.abs, mimeType: mime, label: target.id }],
    };
  }

  return {
    text:
      `${target.id} (${mime}, ${formatBytes(fileSize(target.abs))}) — no readable text, and the pages could not ` +
      'be rendered. Tell the user rather than guessing at the contents.',
  };
}

function renderResult(
  target: Target,
  mime: string,
  text: string,
  tool: string,
  pages: number | undefined,
  textPath?: string,
): string {
  const head = `${target.id} (${mime}, ${formatBytes(fileSize(target.abs))}${pages ? `, ${pages} pages` : ''}, read with ${tool})`;
  const lines = [head];

  if (textPath) {
    lines.push(
      `Complete text: ${textPath} — the exact extracted content, as a file, for searching or quoting past ` +
        'the clip. To keep the document itself, give the original file to `memory_ingest`, which reads it again ' +
        'and files it; do not paste this text into a page.',
    );
  }

  const clipped = text.length > MAX_RESULT_CHARS;
  lines.push('', clipped ? `${text.slice(0, MAX_RESULT_CHARS)}\n[clipped — the rest is in the file above]` : text);
  return lines.join('\n');
}

function resolveContainerTarget(raw: string): Target | string {
  const resolved = resolveSourcePath(raw);
  if ('error' in resolved) return resolved.error;

  // The memory stays reachable only through `memory:`, which copies out
  // read-only — same rule the built-in filesystem tools enforce.
  const blocked = assertKbBlocked(resolved.abs);
  if (blocked) return blocked;

  return {
    abs: resolved.abs,
    id: resolved.abs,
    name: path.basename(resolved.abs),
    key: cacheKeyFor(resolved.abs),
    token: resolved.abs,
  };
}

function resolveMemoryTarget(raw: string): Target | string {
  const resolved = resolveMemoryFile(raw);
  if (typeof resolved === 'string') return resolved;

  // Copy out rather than reading in place, so the extractor never holds a
  // handle on the memory and a stray write cannot land there.
  const staged = stageMemoryFileCopy(resolved.rel, resolved.abs);
  if ('error' in staged) return `Error reading ${resolved.id}: ${staged.error}`;

  return {
    abs: staged.path,
    id: resolved.id,
    name: path.basename(resolved.rel),
    key: cacheKeyFor(resolved.abs),
    token: resolved.rel,
  };
}

/** Cache identity for an arbitrary file, matching the intake's path|size|mtime key. */
function cacheKeyFor(abs: string): string | null {
  try {
    const stat = fs.statSync(abs);
    return cacheKey(abs, stat.size, abs);
  } catch {
    return null;
  }
}

function readIfExists(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Write the `.txt` when there is no cache entry to hang it off. */
/**
 * `.txt` holding the verbatim extraction, for the agent to attach alongside the
 * original.
 *
 * Per-source dir rather than one shared one: keyed on the basename, two
 * documents named `scan.pdf` overwrote each other's text, and a 0444 leftover
 * from an earlier `get` of a same-named memory file made `writeFileSync` throw
 * into the catch below — silently dropping the path the agent was told to
 * attach, which is how the *right* page ends up holding the *wrong* text.
 */
function writeSidecar(token: string, name: string, text: string): string | undefined {
  try {
    const file = path.join(derivedDirFor(token), `${path.basename(name, path.extname(name)) || 'document'}.txt`);
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return undefined;
  }
}
