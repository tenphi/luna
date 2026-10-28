import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  appendMissingEmbeds,
  attachmentNameFor,
  embedLabels,
  listAllMemoryFiles,
  maxFileBytes,
  memoryFileId,
  owningPageSlug,
  removeEmbeds,
  resolveMemoryFile,
  resolveSourcePath,
  rewriteEmbeds,
  scanEmbeds,
  siblingAttachments,
  stripMemoryPrefix,
  uniqueAttachmentName,
  validateMemoryRelPath,
} from './memory-files.js';

let memoryDir: string;
let homeDir: string;

function writeMemoryFile(rel: string, contents = 'bytes'): string {
  const abs = path.join(memoryDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-home-'));
  process.env.LUNA_MEMORY_PATH = memoryDir;
});

afterEach(() => {
  delete process.env.LUNA_MEMORY_PATH;
  delete process.env.LUNA_MEMORY_FILES_MAX_MB;
  delete process.env.LUNA_MEMORY_FILES_BLOCKED_EXT;
  fs.rmSync(memoryDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('validateMemoryRelPath', () => {
  it('rejects traversal, absolute paths, and missing extensions', () => {
    expect(validateMemoryRelPath('../etc/passwd')).toContain('".." segments');
    expect(validateMemoryRelPath('receipts/../../secret.jpg')).toContain('".." segments');
    expect(validateMemoryRelPath('/etc/passwd')).toContain('memory-relative');
    expect(validateMemoryRelPath('receipts/cafe')).toContain('no file extension');
    expect(validateMemoryRelPath('')).toContain('required');
  });

  it('refuses markdown, which pages own', () => {
    expect(validateMemoryRelPath('people/jane.md')).toContain('is a page, not a file');
    expect(validateMemoryRelPath('people/jane.MDX')).toContain('is a page, not a file');
  });

  it('honors the blocked-extension list', () => {
    process.env.LUNA_MEMORY_FILES_BLOCKED_EXT = 'exe,.sh';
    expect(validateMemoryRelPath('tools/setup.sh')).toContain('not allowed');
    expect(validateMemoryRelPath('tools/setup.exe')).toContain('not allowed');
    expect(validateMemoryRelPath('receipts/cafe.jpg')).toBeNull();
  });
});

describe('resolveMemoryFile', () => {
  it('resolves a full id and strips the memory: prefix', () => {
    writeMemoryFile('receipts/cafe.jpg');
    const resolved = resolveMemoryFile('memory:receipts/cafe.jpg');
    expect(typeof resolved).not.toBe('string');
    if (typeof resolved === 'string') return;
    expect(resolved.rel).toBe('receipts/cafe.jpg');
    expect(resolved.id).toBe('memory:receipts/cafe.jpg');
    expect(resolved.abs).toBe(path.join(memoryDir, 'receipts/cafe.jpg'));
  });

  it('accepts a bare basename when it is unique (page bodies carry wikilinks)', () => {
    writeMemoryFile('documents/passport-ada.jpg');
    const resolved = resolveMemoryFile('passport-ada.jpg');
    if (typeof resolved === 'string') throw new Error(resolved);
    expect(resolved.rel).toBe('documents/passport-ada.jpg');
  });

  it('errors with candidates when a bare basename is ambiguous', () => {
    writeMemoryFile('documents/scan.pdf');
    writeMemoryFile('travel/scan.pdf');
    const resolved = resolveMemoryFile('scan.pdf');
    expect(typeof resolved).toBe('string');
    expect(resolved as string).toContain('matches 2 files');
    expect(resolved as string).toContain(memoryFileId('documents/scan.pdf'));
    expect(resolved as string).toContain(memoryFileId('travel/scan.pdf'));
  });

  it('refuses a symlink that escapes the memory', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.jpg'), 'x');
    fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(memoryDir, 'secret.jpg'));
    const resolved = resolveMemoryFile('memory:secret.jpg');
    expect(typeof resolved).toBe('string');
    expect(resolved as string).toContain('symlink');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('reports a missing file with the next move', () => {
    const resolved = resolveMemoryFile('memory:receipts/nope.jpg');
    expect(resolved as string).toContain('memory_recall');
  });

  it('normalizes separators and a leading slash off the prefix', () => {
    expect(stripMemoryPrefix('memory:/receipts/cafe.jpg')).toBe('receipts/cafe.jpg');
    expect(stripMemoryPrefix('MEMORY:receipts\\cafe.jpg')).toBe('receipts/cafe.jpg');
  });
});

describe('resolveSourcePath', () => {
  it('rejects a path inside the memory — attach copies files in, not around', () => {
    writeMemoryFile('receipts/cafe.jpg');
    const result = resolveSourcePath(path.join(memoryDir, 'receipts/cafe.jpg'));
    expect('error' in result && result.error).toContain('already in the knowledge base');
  });

  it('rejects a memory: id, which is not a container path', () => {
    const result = resolveSourcePath('memory:receipts/cafe.jpg');
    expect('error' in result && result.error).toContain('takes container paths');
  });

  it('resolves an existing absolute container path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
    const abs = path.join(dir, 'IMG_4021.jpg');
    fs.writeFileSync(abs, 'x');
    expect(resolveSourcePath(abs)).toEqual({ abs });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('naming', () => {
  it('is the page basename plus the source extension, lowercased', () => {
    expect(attachmentNameFor('documents/passport-ada', 'IMG_4021.JPG')).toBe('passport-ada.jpg');
    expect(attachmentNameFor('travel/trip-2031', '/workspace/inbox/m-1/ticket.pdf')).toBe('trip-2031.pdf');
  });

  it('takes nothing from the source filename but the extension', () => {
    // The regression: a page named for the bill must not inherit the invoice
    // number the channel happened to use as a filename.
    expect(attachmentNameFor('receipts/water-annual-bill-2031-04-02', 'blackwater-water-invoice-0001.pdf')).toBe(
      'water-annual-bill-2031-04-02.pdf',
    );
  });

  it('sanitizes a slug that would break a wikilink', () => {
    expect(attachmentNameFor('people/Jane Doe [HR]', 'card.png')).toBe('jane-doe-hr.png');
  });

  it('falls back to "file" for a slug with nothing usable left', () => {
    expect(attachmentNameFor('...', 'scan.pdf')).toBe('file.pdf');
  });

  it('keeps a bare name when the source has no extension', () => {
    expect(attachmentNameFor('travel/lisbon', 'ticket')).toBe('lisbon');
  });

  it('auto-suffixes -2, -3 against disk and the in-batch reservations', () => {
    writeMemoryFile('travel/lisbon.pdf');
    const dir = path.join(memoryDir, 'travel');
    const taken = new Set<string>();
    const first = uniqueAttachmentName(dir, 'lisbon.pdf', taken);
    taken.add(first);
    const second = uniqueAttachmentName(dir, 'lisbon.pdf', taken);
    expect(first).toBe('lisbon-2.pdf');
    expect(second).toBe('lisbon-3.pdf');
  });

  it('does not collide a .txt sidecar with its source document', () => {
    // A page write can attach the original and its extracted text together;
    // uniqueAttachmentName keys on the full name, so neither gets a -2.
    writeMemoryFile('receipts/bill.pdf');
    const dir = path.join(memoryDir, 'receipts');
    expect(uniqueAttachmentName(dir, 'bill.txt')).toBe('bill.txt');
    expect(uniqueAttachmentName(dir, 'bill.pdf')).toBe('bill-2.pdf');
  });
});

describe('embeds', () => {
  const body = '# Passport\n\nAda Marlow, expires 2031.\n\n![[passport-ada.jpg]]\n';

  it('scans embeds, ignoring aliases and anchors', () => {
    expect([...scanEmbeds('![[a.jpg|thumb]] ![[b.pdf#page=2]]')]).toEqual(['a.jpg', 'b.pdf']);
  });

  it('passes a fully-embedded body through byte-for-byte', () => {
    expect(appendMissingEmbeds(body, ['passport-ada.jpg'])).toBe(body);
  });

  it('appends only the files the body does not already embed', () => {
    const out = appendMissingEmbeds(body, ['passport-ada.jpg', 'passport-ada-address-page.jpg']);
    expect(out).toContain('![[passport-ada-address-page.jpg]]');
    expect(out.split('![[passport-ada.jpg]]').length - 1).toBe(1);
    expect(out).toContain('## Files');
  });

  it('drops embeds for removed files and cleans up the empty Files block', () => {
    const withBlock = appendMissingEmbeds('# Trip\n', ['lisbon.pdf']);
    const out = removeEmbeds(withBlock, ['lisbon.pdf']);
    expect(out).not.toContain('![[lisbon.pdf]]');
    expect(out).not.toContain('## Files');
  });

  it('rewrites embeds for a rename', () => {
    const out = rewriteEmbeds(body, new Map([['passport-ada.jpg', 'passport-ada-marlow.jpg']]));
    expect(out).toContain('![[passport-ada-marlow.jpg]]');
  });

  it('appends into an existing Files section instead of starting a second one', () => {
    const withBlock = appendMissingEmbeds('# Trip\n', ['lisbon.pdf']);
    const out = appendMissingEmbeds(withBlock, ['lisbon.pdf', 'lisbon-2.pdf']);
    expect(out.match(/## Files/g)).toHaveLength(1);
    expect(out).toContain('![[lisbon-2.pdf]]');
  });

  describe('labels', () => {
    it('writes one line per labeled file, saying which is which', () => {
      const out = appendMissingEmbeds('# Passport\n', [
        { name: 'passport-ada.jpg', label: 'photo page' },
        { name: 'passport-ada-2.jpg', label: 'address page' },
      ]);
      expect(out).toContain('- ![[passport-ada.jpg]] — photo page');
      expect(out).toContain('- ![[passport-ada-2.jpg]] — address page');
    });

    it('leaves a body that already describes each file byte-for-byte', () => {
      const described = '# Passport\n\n![[passport-ada.jpg]] — photo page\n';
      expect(appendMissingEmbeds(described, [{ name: 'passport-ada.jpg', label: 'photo page' }])).toBe(described);
    });

    it('links, not re-embeds, a labeled file the body already shows', () => {
      const out = appendMissingEmbeds(body, [{ name: 'passport-ada.jpg', label: 'photo page' }]);
      expect(out).toContain('- [[passport-ada.jpg]] — photo page');
      // Rendered once, not twice.
      expect(out.match(/!\[\[passport-ada\.jpg\]\]/g)).toHaveLength(1);
    });

    it('references every file it renders as an embed, so the next call sees it', () => {
      // Regression guard: a plain [[link]] for an un-embedded file would be
      // invisible to scanEmbeds, so every later attach would append it again.
      const out = appendMissingEmbeds('# Passport\n', [
        { name: 'a.jpg', label: 'front' },
        { name: 'b.jpg', label: 'back' },
      ]);
      expect(scanEmbeds(out)).toEqual(new Set(['a.jpg', 'b.jpg']));
      expect(
        appendMissingEmbeds(out, [
          { name: 'a.jpg', label: 'front' },
          { name: 'b.jpg', label: 'back' },
        ]),
      ).toBe(out);
    });

    it('removes a labeled index line whole, leaving no orphan caption', () => {
      const withIndex = appendMissingEmbeds('# Passport\n', [
        { name: 'a.jpg', label: 'front' },
        { name: 'b.jpg', label: 'back' },
      ]);
      const out = removeEmbeds(withIndex, ['a.jpg']);
      expect(out).not.toContain('front');
      expect(out).not.toContain('-  —');
      expect(out).toContain('- ![[b.jpg]] — back');
    });

    it('rewrites a plain-link index line on a rename, without double-applying', () => {
      const withIndex = appendMissingEmbeds('# Passport\n\n![[jane.jpg]]\n', [
        { name: 'jane.jpg', label: 'front' },
        { name: 'jane-2.jpg', label: 'back' },
      ]);
      // jane.jpg's new name is jane-2.jpg's old name — a one-pass rewrite must
      // not carry the first rename into the second.
      const out = rewriteEmbeds(
        withIndex,
        new Map([
          ['jane.jpg', 'jane-2.jpg'],
          ['jane-2.jpg', 'jane-2-2.jpg'],
        ]),
      );
      expect(out).toContain('- [[jane-2.jpg]] — front');
      expect(out).toContain('- ![[jane-2-2.jpg]] — back');
      expect(out).not.toContain('jane-2-2-2');
    });

    it('removes a plain-link index line too', () => {
      const withIndex = appendMissingEmbeds('# Passport\n\n![[a.jpg]]\n', [
        { name: 'a.jpg', label: 'front' },
        { name: 'b.jpg', label: 'back' },
      ]);
      const out = removeEmbeds(withIndex, ['a.jpg']);
      expect(out).not.toContain('a.jpg');
      expect(out).not.toContain('front');
    });
  });
});

describe('siblings', () => {
  it("finds a page's attachments, including numbered extras", () => {
    writeMemoryFile('documents/passport-ada.md', '# Passport');
    writeMemoryFile('documents/passport-ada.jpg');
    writeMemoryFile('documents/passport-ada-2.jpg');
    writeMemoryFile('documents/passport-bo.jpg');
    expect(siblingAttachments('documents/passport-ada')).toEqual([
      'documents/passport-ada-2.jpg',
      'documents/passport-ada.jpg',
    ]);
  });

  it('still adopts purpose-labelled files written before the naming rule', () => {
    // Knowledge bases predating the exact-name rule hold `<page>-<label>.ext`; nothing
    // migrates them, so they must keep resolving to their page.
    writeMemoryFile('documents/passport-ada.md', '# Passport');
    writeMemoryFile('documents/passport-ada-address-page.jpg');
    expect(siblingAttachments('documents/passport-ada')).toEqual(['documents/passport-ada-address-page.jpg']);
  });

  it('does not claim a file owned by a longer page in the same folder', () => {
    // Date-suffixed slugs are ordinary, and callers destroy what this returns:
    // replace_files trashes it, delete_memory_page deletes it, move renames it.
    writeMemoryFile('receipts/bill.md', '# Bill');
    writeMemoryFile('receipts/bill.pdf');
    writeMemoryFile('receipts/bill-2031-04-02.md', '# April bill');
    writeMemoryFile('receipts/bill-2031-04-02.pdf');

    expect(siblingAttachments('receipts/bill')).toEqual(['receipts/bill.pdf']);
    expect(siblingAttachments('receipts/bill-2031-04-02')).toEqual(['receipts/bill-2031-04-02.pdf']);
  });

  it('adopts an unowned suffixed file, so a create can pick up its own bytes', () => {
    // applyAttachments copies before the page .md exists.
    writeMemoryFile('travel/lisbon-2.pdf');
    expect(siblingAttachments('travel/lisbon')).toEqual(['travel/lisbon-2.pdf']);
  });

  it('resolves the owning page by peeling suffixes, and reports orphans', () => {
    writeMemoryFile('travel/lisbon.md', '# Lisbon');
    writeMemoryFile('travel/lisbon-2.pdf');
    writeMemoryFile('travel/loose.pdf');
    expect(owningPageSlug('travel/lisbon-2.pdf')).toBe('travel/lisbon');
    expect(owningPageSlug('travel/loose.pdf')).toBeNull();
  });

  it('lists every non-markdown file, skipping dot dirs', () => {
    writeMemoryFile('travel/lisbon.md', '# Lisbon');
    writeMemoryFile('travel/lisbon.pdf');
    writeMemoryFile('.sources/cached.pdf');
    expect(listAllMemoryFiles()).toEqual(['travel/lisbon.pdf']);
  });
});

describe('embedLabels', () => {
  it('reads back the shape appendMissingEmbeds writes', () => {
    const labels = embedLabels('## Files\n\n- ![[permit.jpg]] — front side\n- ![[permit-2.jpg]] — back side\n');
    expect(labels.get('permit.jpg')).toBe('front side');
    expect(labels.get('permit-2.jpg')).toBe('back side');
  });

  it('handles the !-less bullet form and omits uncaptioned embeds', () => {
    const labels = embedLabels('- [[notes.pdf]] — meeting notes\n- ![[bare.jpg]]\n');
    expect(labels.get('notes.pdf')).toBe('meeting notes');
    expect(labels.has('bare.jpg')).toBe(false);
  });

  it('ignores page cross-links in prose, which are not file captions', () => {
    const labels = embedLabels('See [[people/jane]] — she signed it.\n\nInline ![[scan.jpg]] — not a bullet\n');
    expect(labels.has('people/jane')).toBe(false);
    expect(labels.has('jane')).toBe(false);
    expect(labels.has('scan.jpg')).toBe(false);
  });

  it('keys on basename, so a scoped embed still resolves', () => {
    expect(embedLabels('- ![[personal/permit.jpg]] — mine\n').get('permit.jpg')).toBe('mine');
  });

  it('clips a caption to a caption', () => {
    const long = 'x'.repeat(200);
    expect(embedLabels(`- ![[a.jpg]] — ${long}\n`).get('a.jpg')!.length).toBe(80);
  });
});

describe('limits', () => {
  it('reads the size cap from the injected config', () => {
    expect(maxFileBytes()).toBe(25 * 1024 * 1024);
    process.env.LUNA_MEMORY_FILES_MAX_MB = '5';
    expect(maxFileBytes()).toBe(5 * 1024 * 1024);
  });
});
