/**
 * Deterministic text extraction from documents, run by the **runtime** rather
 * than by the agent.
 *
 * The agent used to do this itself: the `document-extraction` skill told it to
 * shell out to `pdftotext`, read the output, and reason over it. That costs two
 * extra model round-trips before the agent knows what it is even looking at —
 * and it happens *after* the topic decision, which by then has already filed a
 * text-less PDF under whatever the conversation was about a minute ago.
 * Extracting here puts the content in front of every consumer that needs it:
 * the topic classifier, the recall query, and the agent's own prompt.
 *
 * The binaries all ship in the agent image (`container/Dockerfile`):
 * `poppler-utils` (pdftotext, pdftoppm, pdfinfo), `pandoc`, and `tesseract-ocr`
 * with English data only.
 *
 * Everything here is best-effort. A missing binary, a non-zero exit, a timeout,
 * or a corrupt file all resolve to `null` rather than throwing — a failed digest
 * must never be able to take a turn down.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Which tool can read a file, by extension and MIME. */
export type ExtractorKind = 'pdf' | 'pandoc' | 'ocr' | 'text';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed for exceeding its timeout. */
  timedOut: boolean;
}

/** Injectable process runner — tests have no poppler/pandoc/tesseract. */
export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const DEFAULT_TIMEOUT_MS = 15_000;
/** Beyond this a document's text stops being a digest and starts being a dump. */
const MAX_EXTRACT_CHARS = 400_000;

const PANDOC_EXTS = new Set(['docx', 'odt', 'rtf', 'epub', 'html', 'htm', 'doc']);
const OCR_EXTS = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif']);
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'ics', 'vcf', 'xml']);

function log(msg: string): void {
  console.error(`[doc-extract] ${msg}`);
}

function extensionOf(name: string): string {
  const base = path.basename(name);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * Which extractor reads this file, or null when nothing here can.
 *
 * MIME is consulted first for `pdf` and `text/*` because Telegram documents
 * carry a reliable MIME and an occasionally useless filename; extension wins
 * elsewhere, since `application/octet-stream` is the common lie.
 */
export function extractorFor(name: string, mimeType?: string): ExtractorKind | null {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';

  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (PANDOC_EXTS.has(ext)) return 'pandoc';
  if (OCR_EXTS.has(ext)) return 'ocr';
  if (TEXT_EXTS.has(ext)) return 'text';

  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (mime.startsWith('image/')) return 'ocr';
  return null;
}

/** Spawn a command, capture stdout/stderr, and kill it past `timeoutMs`. */
export const runCommand: RunFn = (cmd, args, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_EXTRACT_CHARS) stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

export interface ExtractOptions {
  /** Cap for PDFs; ignored by the other extractors. */
  maxPages?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  run?: RunFn;
}

export interface ExtractResult {
  text: string;
  /** Which binary produced it, for the digest's provenance line. */
  tool: string;
}

/**
 * Extract a document's text. Returns null when this file has no extractor, the
 * tool failed, or the output was empty — a text-less PDF lands here, and the
 * caller falls back to rendering pages for a vision pass.
 */
export async function extractText(
  absPath: string,
  name: string,
  mimeType: string | undefined,
  opts: ExtractOptions = {},
): Promise<ExtractResult | null> {
  const kind = extractorFor(name, mimeType);
  if (!kind) return null;

  const run = opts.run ?? runCommand;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  switch (kind) {
    case 'pdf':
      return pdfText(absPath, { ...opts, run, timeoutMs });
    case 'pandoc':
      return finish(await run('pandoc', [absPath, '-t', 'plain'], timeoutMs), 'pandoc');
    case 'ocr':
      // `--psm 3` is the default page-segmentation mode; naming it keeps the
      // behavior stable if a future tesseract changes its default.
      return finish(await run('tesseract', [absPath, 'stdout', '--psm', '3'], timeoutMs), 'tesseract');
    case 'text':
      return plainText(absPath);
  }
}

/** Native PDF text. `-layout` is what keeps receipt and invoice tables readable. */
export async function pdfText(
  absPath: string,
  opts: ExtractOptions & { run?: RunFn; timeoutMs?: number } = {},
): Promise<ExtractResult | null> {
  const run = opts.run ?? runCommand;
  const args = ['-layout', ...(opts.maxPages ? ['-l', String(opts.maxPages)] : []), absPath, '-'];
  return finish(await run('pdftotext', args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 'pdftotext');
}

/** Page count, for the digest. Null when pdfinfo is unavailable or unhelpful. */
export async function pdfPageCount(absPath: string, opts: ExtractOptions = {}): Promise<number | null> {
  const run = opts.run ?? runCommand;
  const res = await run('pdfinfo', [absPath], opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (res.status !== 0) return null;
  const match = /^Pages:\s+(\d+)/m.exec(res.stdout);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Rasterize the first `pages` pages to PNGs in `outDir`.
 *
 * Only worth doing for a PDF with no text layer — a scan. Returns the files in
 * page order so a vision pass reads them the way a person would.
 */
export async function renderPdfPages(
  absPath: string,
  outDir: string,
  pages: number,
  opts: ExtractOptions = {},
): Promise<string[]> {
  const run = opts.run ?? runCommand;
  const prefix = path.join(outDir, `${path.basename(absPath, path.extname(absPath))}-page`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    return [];
  }

  const res = await run(
    'pdftoppm',
    ['-png', '-r', '120', '-f', '1', '-l', String(pages), absPath, prefix],
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (res.status !== 0) {
    if (res.timedOut) log(`pdftoppm timed out on ${path.basename(absPath)}`);
    return [];
  }

  try {
    const base = path.basename(prefix);
    return fs
      .readdirSync(outDir)
      .filter((n) => n.startsWith(`${base}-`) && n.endsWith('.png'))
      .sort()
      .slice(0, pages)
      .map((n) => path.join(outDir, n));
  } catch {
    return [];
  }
}

function plainText(absPath: string): ExtractResult | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8').slice(0, MAX_EXTRACT_CHARS);
    const text = raw.trim();
    return text ? { text, tool: 'read' } : null;
  } catch {
    return null;
  }
}

function finish(res: RunResult, tool: string): ExtractResult | null {
  if (res.status !== 0) {
    if (res.timedOut) log(`${tool} timed out`);
    else if (res.stderr.trim()) log(`${tool} failed: ${res.stderr.trim().slice(0, 200)}`);
    return null;
  }
  const text = res.stdout.trim();
  return text ? { text: text.slice(0, MAX_EXTRACT_CHARS), tool } : null;
}

/**
 * Is this extraction worth passing on as evidence?
 *
 * OCR on a photo of a dog returns a page of punctuation, and a false topic
 * switch on that noise is the expensive failure — it drops the working context
 * of something the user is ten turns into. So a floor: enough characters,
 * enough real words, and mostly plausible characters. Cheap to compute and it
 * only has to catch the obvious garbage; the classifier's own continue-bias
 * handles the rest.
 */
export function looksLikeRealText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 16) return false;

  const words = trimmed.split(/\s+/).filter((w) => /[a-z0-9]{3,}/i.test(w));
  if (words.length < 3) return false;

  const plausible = (trimmed.match(/[\p{L}\p{N}\s.,:;!?'"()\-/@€$%&+#*[\]]/gu) ?? []).length;
  return plausible / trimmed.length >= 0.8;
}
