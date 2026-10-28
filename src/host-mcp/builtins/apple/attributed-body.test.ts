import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { extractTextFromAttributedBody, getMessageText } from './servers/messages-db.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'imessage-attributed-body');

function loadFixture(name: string): { bin: Buffer; expected: string } {
  return {
    bin: fs.readFileSync(path.join(fixturesDir, `${name}.bin`)),
    expected: fs.readFileSync(path.join(fixturesDir, `${name}.txt`), 'utf-8'),
  };
}

describe('apple-messages attributedBody decoder (vendored, fixed)', () => {
  it('decodes long carrier messages past the old 150-char truncation', () => {
    const { bin, expected } = loadFixture('travel-notice-long');
    const text = extractTextFromAttributedBody(bin);
    expect(text).toBe(expected);
    expect(text!.length).toBe(384);
    expect(text).toContain('example.test/help');
    // The 0x01 is the point: NSKeyedArchiver's marker byte used to survive into the decoded
    // string, so a literal control character is exactly what this must look for.
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/^\u0001/);
    // The old buggy decoder stopped after about 150 characters, mid-word
    expect(text!.length).toBeGreaterThan(150);
  });

  it('decodes short emoji-only bodies without corrupting trailing UTF-8 bytes', () => {
    const { bin, expected } = loadFixture('emoji-short');
    const text = extractTextFromAttributedBody(bin);
    expect(text).toBe(expected);
    expect(text).toBe('🥇🥇🥇');
  });

  it('prefers the plain text column when present', () => {
    const { bin } = loadFixture('travel-notice-long');
    expect(getMessageText('plain', bin)).toBe('plain');
    expect(getMessageText(null, bin)).toContain('Blackwater Bay');
  });

  it('returns null for empty or missing blobs', () => {
    expect(extractTextFromAttributedBody(null)).toBeNull();
    expect(extractTextFromAttributedBody(Buffer.alloc(0))).toBeNull();
    expect(extractTextFromAttributedBody(Buffer.from('no-payload-here'))).toBeNull();
  });
});
