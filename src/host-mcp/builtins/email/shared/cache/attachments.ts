/**
 * Extracted attachment text, keyed by content.
 *
 * By SHA-256 of the bytes, not by (message, part). Attachments repeat constantly — a contract goes
 * round a thread four times, a statement is forwarded from one person to another, the same invoice
 * arrives in both mailboxes. Keying on content means each distinct file is OCR'd once, ever, no
 * matter how many messages carry it. On a scanned PDF that is the difference between a second and
 * fifteen.
 *
 * Safe for the same reason the body cache is: bytes that hash the same *are* the same bytes, so the
 * extraction cannot have changed.
 */
import { createHash } from 'crypto';

import { getMailDb } from './db.js';

export type ExtractionMethod = 'pdfkit' | 'vision-ocr' | 'plain' | 'no-text-found';

export interface ExtractedText {
  text: string;
  method: ExtractionMethod;
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function getExtractedText(sha256: string): ExtractedText | null {
  const row = getMailDb().prepare('SELECT text, method FROM attachment_text WHERE sha256 = ?').get(sha256) as
    | { text: string; method: string }
    | undefined;
  return row ? { text: row.text, method: row.method as ExtractionMethod } : null;
}

export function putExtractedText(
  sha256: string,
  meta: { filename: string; mimeType: string; bytes: number },
  extracted: ExtractedText,
): void {
  getMailDb()
    .prepare(
      `INSERT INTO attachment_text (sha256, filename, mime_type, bytes, text, method, extracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256) DO UPDATE SET text = excluded.text, method = excluded.method`,
    )
    .run(sha256, meta.filename, meta.mimeType, meta.bytes, extracted.text, extracted.method, new Date().toISOString());
}
