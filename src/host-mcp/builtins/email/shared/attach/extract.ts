/**
 * Turning an attachment into text the agent can read.
 *
 * Three routes, chosen by MIME type:
 *
 *   - Text-shaped files (`text/*`, JSON, CSV, XML) are decoded and returned. No helper, no cost.
 *   - PDFs and images go to the `mail-extract` Swift helper: PDFKit's text layer where there is
 *     one, Vision OCR per page where there is not.
 *   - Everything else is refused, by name, pointing at `save_attachment`. A spreadsheet or a zip is
 *     not text and pretending otherwise would hand the agent mojibake to reason over.
 *
 * The refusal matters as much as the extraction. An agent given 400 KB of decoded ZIP will try to
 * answer from it.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../../../../log.js';
import {
  getExtractedText,
  hashBytes,
  putExtractedText,
  type ExtractedText,
  type ExtractionMethod,
} from '../cache/attachments.js';
import type { AttachmentMeta } from '../types.js';

/** Vision OCR over a long scan is slow; this is generous enough not to truncate a real document. */
const EXTRACT_TIMEOUT_MS = 180_000;

/** Past this, extraction is not the right tool — `save_attachment` is. */
export const MAX_EXTRACT_BYTES = 40 * 1024 * 1024;

/**
 * The committed universal binary, resolved from the project root.
 *
 * It lives under `src/` and is *not* compiled into `dist/`, matching how `calendar-helper` is
 * handled — the binary is a committed build artifact so an install needs no Swift toolchain.
 */
export function resolveMailExtract(projectRoot: string = process.cwd()): string {
  return path.join(projectRoot, 'src', 'host-mcp', 'builtins', 'email', 'shared', 'attach', 'native', 'mail-extract');
}

const TEXTUAL = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|csv|javascript|x-sh)$)/i;
const PDF = /^application\/pdf$/i;
const IMAGE = /^image\/(?:png|jpe?g|tiff?|gif|bmp|heic|heif|webp)$/i;

export class UnsupportedAttachment extends Error {
  constructor(meta: AttachmentMeta) {
    super(
      `${meta.filename} is ${meta.mimeType}, which has no text to extract. ` +
        `Use save_attachment to put it in the workspace — then it can be given to memory, or opened with a tool that ` +
        `understands that format.`,
    );
    this.name = 'UnsupportedAttachment';
  }
}

interface HelperResult {
  text?: string;
  method?: string;
  pages?: number;
  error?: string;
}

function runHelper(filePath: string): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const binary = resolveMailExtract();
    if (!fs.existsSync(binary)) {
      reject(new Error(`The attachment text extractor is not built. Run:\n  ./scripts/build-mail-extract.sh`));
      return;
    }

    execFile(binary, [filePath], { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      // The helper reports failures as JSON on stdout with a non-zero exit, so a parseable body is
      // preferred over the process error even when the exit code is set.
      let parsed: HelperResult | null;
      try {
        parsed = JSON.parse(stdout) as HelperResult;
      } catch {
        parsed = null;
      }
      if (parsed?.error) {
        reject(new Error(parsed.error));
        return;
      }
      if (err) {
        reject(err);
        return;
      }
      if (!parsed) {
        reject(new Error('the attachment text extractor returned nothing readable'));
        return;
      }
      resolve(parsed);
    });
  });
}

function decodeTextual(bytes: Buffer): ExtractedText {
  return { text: bytes.toString('utf-8'), method: 'plain' };
}

/**
 * Extract, cached by content hash.
 *
 * The bytes are written to a temp file because the helper takes a path: PDFKit and Vision both want
 * a file, and streaming a 30 MB scan through stdin to avoid one write in `os.tmpdir()` would buy
 * nothing. The file is removed whether or not extraction succeeds.
 */
export async function extractAttachmentText(meta: AttachmentMeta, bytes: Buffer): Promise<ExtractedText> {
  const sha256 = hashBytes(bytes);
  const cached = getExtractedText(sha256);
  if (cached) return cached;

  const extracted = await extractUncached(meta, bytes);
  putExtractedText(sha256, { filename: meta.filename, mimeType: meta.mimeType, bytes: bytes.length }, extracted);
  return extracted;
}

async function extractUncached(meta: AttachmentMeta, bytes: Buffer): Promise<ExtractedText> {
  if (TEXTUAL.test(meta.mimeType)) return decodeTextual(bytes);

  const isPdf = PDF.test(meta.mimeType) || meta.filename.toLowerCase().endsWith('.pdf');
  const isImage = IMAGE.test(meta.mimeType);
  if (!isPdf && !isImage) throw new UnsupportedAttachment(meta);

  if (bytes.length > MAX_EXTRACT_BYTES) {
    throw new Error(
      `${meta.filename} is ${Math.round(bytes.length / 1024 / 1024)} MB, past the ` +
        `${MAX_EXTRACT_BYTES / 1024 / 1024} MB extraction limit. Use save_attachment instead.`,
    );
  }

  // The extension is what tells the helper which route to take, so it has to survive the temp file.
  const suffix = isPdf ? '.pdf' : path.extname(meta.filename) || '.png';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-mail-'));
  const filePath = path.join(dir, `attachment${suffix}`);

  try {
    fs.writeFileSync(filePath, bytes);
    const result = await runHelper(filePath);
    const method = (result.method ?? 'no-text-found') as ExtractionMethod;
    if (method === 'vision-ocr') {
      log.info('attachment OCR', { filename: meta.filename, pages: result.pages });
    }
    return { text: result.text ?? '', method };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
