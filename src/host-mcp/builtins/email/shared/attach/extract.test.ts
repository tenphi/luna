import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeMailDb, useInMemoryMailDb } from '../cache/db.js';
import { extractAttachmentText, MAX_EXTRACT_BYTES, UnsupportedAttachment } from './extract.js';
import type { AttachmentMeta } from '../types.js';

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return { attachmentId: '2', filename: 'notes.txt', mimeType: 'text/plain', bytes: 12, ...overrides };
}

beforeEach(() => {
  useInMemoryMailDb();
});

afterEach(() => {
  closeMailDb();
});

describe('extractAttachmentText', () => {
  it('decodes a text attachment without touching the helper', async () => {
    const result = await extractAttachmentText(meta(), Buffer.from('the meeting is at four'));

    expect(result).toEqual({ text: 'the meeting is at four', method: 'plain' });
  });

  it('treats JSON and CSV as text', async () => {
    for (const mimeType of ['application/json', 'application/csv', 'text/csv', 'application/xml']) {
      const result = await extractAttachmentText(meta({ mimeType }), Buffer.from('a,b'));
      expect(result.method).toBe('plain');
    }
  });

  it('refuses a format with no text, and names the tool to use instead', async () => {
    await expect(
      extractAttachmentText(meta({ filename: 'archive.zip', mimeType: 'application/zip' }), Buffer.from('PK')),
    ).rejects.toThrow(UnsupportedAttachment);

    await expect(
      extractAttachmentText(meta({ filename: 'archive.zip', mimeType: 'application/zip' }), Buffer.from('PK')),
    ).rejects.toThrow(/save_attachment/);
  });

  it('refuses a file past the extraction limit rather than spending minutes on it', async () => {
    const huge = Buffer.alloc(MAX_EXTRACT_BYTES + 1);

    await expect(
      extractAttachmentText(meta({ filename: 'scan.pdf', mimeType: 'application/pdf' }), huge),
    ).rejects.toThrow(/save_attachment/);
  });

  it('serves a repeat of the same bytes from cache, whatever the message called it', async () => {
    const bytes = Buffer.from('shared contract text');
    await extractAttachmentText(meta({ filename: 'contract.txt' }), bytes);

    // Same content, different message and filename — content-addressed, so it is one extraction.
    const again = await extractAttachmentText(meta({ attachmentId: '7', filename: 'forwarded.txt' }), bytes);

    expect(again.text).toBe('shared contract text');
  });
});
