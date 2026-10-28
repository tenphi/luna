import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resetAttachmentCacheForTests, writeCached, cacheKey } from '../../../attachment-cache.js';
import { callDocumentTool, documentToolSchemas, EXTRACT_DOCUMENT, isDocumentTool } from './document-tools.js';

let workspace: string;
let memoryDir: string;
let homeDir: string;
let prevWorkspace: string | undefined;

function write(rel: string, contents: string, root = workspace): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
  return abs;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-doctool-'));
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-doctool-memory-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-doctool-home-'));
  prevWorkspace = process.env.LUNA_TEST_WORKSPACE;
  process.env.LUNA_TEST_WORKSPACE = workspace;
  process.env.LUNA_MEMORY_PATH = memoryDir;
  resetAttachmentCacheForTests();
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.LUNA_TEST_WORKSPACE;
  else process.env.LUNA_TEST_WORKSPACE = prevWorkspace;
  delete process.env.LUNA_MEMORY_PATH;
  resetAttachmentCacheForTests();
  for (const dir of [workspace, memoryDir, homeDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('extract_document registration', () => {
  it('is advertised unconditionally — reading a download has nothing to do with memory', () => {
    delete process.env.LUNA_MEMORY_PATH;
    expect(documentToolSchemas().map((t) => t.function.name)).toEqual([EXTRACT_DOCUMENT]);
  });

  it('recognizes its own name only', () => {
    expect(isDocumentTool(EXTRACT_DOCUMENT)).toBe(true);
    expect(isDocumentTool('manage_memory_file')).toBe(false);
  });
});

describe('extract_document arguments', () => {
  it('requires one of path or memory', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, {});
    expect(res.text).toContain('Error:');
    // And points the agent at the block it should have read first.
    expect(res.text).toContain('<attachments>');
  });

  it('refuses both at once', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: '/a.pdf', memory: 'memory:x.pdf' });
    expect(res.text).toContain('not both');
  });

  it('reports a missing file plainly', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: path.join(workspace, 'nope.pdf') });
    expect(res.text).toContain('file not found');
  });
});

describe('extract_document on a container path', () => {
  it('reads a plain text file and offers the full text as a .txt', async () => {
    const file = write('agent/notes.txt', 'Blackwater Bay Water annual bill\nAmount due 42.00 EUR');
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });

    expect(res.text).toContain('Amount due 42.00 EUR');
    expect(res.text).toContain('read with read');
    const match = /Complete text: (\S+\.txt)/.exec(res.text);
    expect(match).not.toBeNull();
    expect(fs.readFileSync(match![1]!, 'utf-8')).toContain('Amount due 42.00 EUR');
    // The wording the agent needs to act on: the file goes to ingest, not this text.
    expect(res.text).toContain('memory_ingest');
  });

  it('says so plainly for a format nothing here can read', async () => {
    const file = write('agent/note.ogg', 'oggbytes');
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });
    expect(res.text).toContain('nothing in this container can read that format');
  });

  it('refuses a path inside the memory, so the KB stays behind its tools', async () => {
    // `resolveSourcePath` catches the memory root first with its own wording;
    // either way the bytes never come back and the agent is pointed at `memory:`.
    const inMemoryKb = write('receipts/bill.txt', 'secret', memoryDir);
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: inMemoryKb });

    expect(res.text).toStartWith('Error:');
    expect(res.text).toContain('knowledge base');
    expect(res.text).not.toContain('secret');
  });

  it('refuses a path inside the knowledge base, which only the KB guard covers', async () => {
    const inMemory = write('people/jane.md', 'jane page', memoryDir);
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: inMemory });

    expect(res.text).toContain('already in the knowledge base');
    expect(res.text).not.toContain('jane page');
  });

  it('tells the agent memory: ids do not belong in `path`', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: 'memory:receipts/bill.pdf' });
    expect(res.text).toContain('already in the knowledge base');
  });
});

describe('extract_document on a memory: id', () => {
  it('reads a stored file through a read-only copy, never the original', async () => {
    write('documents/passport.md', '# Passport', memoryDir);
    const original = write('documents/passport.txt', 'Ada Marlow, expires 2031', memoryDir);
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { memory: 'memory:documents/passport.txt' });

    expect(res.text).toContain('memory:documents/passport.txt');
    expect(res.text).toContain('expires 2031');
    // The memory copy is untouched and the extraction ran on a cache copy.
    expect(fs.readFileSync(original, 'utf-8')).toBe('Ada Marlow, expires 2031');
    expect(res.text).not.toContain(memoryDir);
  });

  it('reports an unknown id without inventing content', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { memory: 'memory:documents/ghost.pdf' });
    expect(res.text).toContain('no file');
  });

  it('refuses a page slug — pages are not files', async () => {
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { memory: 'memory:people/jane.md' });
    expect(res.text).toContain('is a page, not a file');
  });
});

describe('extract_document cache sharing', () => {
  it("serves the intake's stored text instead of re-extracting", async () => {
    const file = write('agent/bill.txt', 'ORIGINAL BYTES');
    const stat = fs.statSync(file);
    // What the intake stage would have left behind for this exact file.
    writeCached(
      cacheKey(file, stat.size, file),
      { name: 'bill.txt', mimeType: 'text/plain', bytes: stat.size, isImage: false, text: 'digest', tool: 'pdftotext' },
      'FULL TEXT FROM THE INTAKE',
    );

    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });
    expect(res.text).toContain('FULL TEXT FROM THE INTAKE');
    expect(res.text).not.toContain('ORIGINAL BYTES');
  });
});

describe('extract_document shows images, not just their text', () => {
  it('returns the picture alongside cached OCR text', async () => {
    const file = write('agent/scans/ada-front.jpg', 'jpegbytes');
    const stat = fs.statSync(file);
    writeCached(
      cacheKey(file, stat.size, file),
      { name: 'ada-front.jpg', mimeType: 'image/jpeg', bytes: stat.size, isImage: true, text: 'd', tool: 'ocr' },
      'MARLOW ADA XX0000000',
    );

    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });
    expect(res.text).toContain('MARLOW');
    // OCR text is a claim about bytes the agent has not seen; the image is the
    // only way it can check a crop it made itself before filing it.
    expect(res.images).toHaveLength(1);
    expect(res.images![0]!.path).toBe(file);
    expect(res.images![0]!.mimeType).toBe('image/jpeg');
    expect(res.images![0]!.label).toBe(file);
  });

  it('still shows an image OCR found no text in', async () => {
    const file = write('agent/scans/blank.png', 'notarealpng');
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });

    expect(res.text).toContain('no readable text');
    expect(res.text).not.toContain('could not be rendered');
    expect(res.images).toHaveLength(1);
    expect(res.images![0]!.path).toBe(file);
  });

  it('leaves non-image results text-only', async () => {
    const file = write('agent/notes.txt', 'plain text');
    const res = await callDocumentTool(EXTRACT_DOCUMENT, { path: file });
    expect(res.images).toBeUndefined();
  });
});
