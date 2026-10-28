import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  cacheKey,
  cacheRoot,
  readCached,
  resetAttachmentCacheForTests,
  writeCached,
  type AttachmentDigest,
} from './attachment-cache.js';

let workspace: string;
let prevWorkspace: string | undefined;

function stage(name: string, bytes = 'bytes'): { localPath: string; abs: string; bytes: number } {
  const localPath = `inbox/msg-1/${name}`;
  const abs = path.join(workspace, localPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return { localPath, abs, bytes: bytes.length };
}

function digest(overrides: Partial<AttachmentDigest> = {}): AttachmentDigest {
  return {
    name: 'bill.pdf',
    mimeType: 'application/pdf',
    bytes: 1024,
    isImage: false,
    text: 'Amount due €42.00',
    tool: 'pdftotext',
    ...overrides,
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-att-cache-'));
  prevWorkspace = process.env.LUNA_TEST_WORKSPACE;
  process.env.LUNA_TEST_WORKSPACE = workspace;
  resetAttachmentCacheForTests();
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.LUNA_TEST_WORKSPACE;
  else process.env.LUNA_TEST_WORKSPACE = prevWorkspace;
  resetAttachmentCacheForTests();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('is stable for the same file', () => {
    const file = stage('bill.pdf');
    expect(cacheKey(file.localPath, file.bytes, file.abs)).toBe(cacheKey(file.localPath, file.bytes, file.abs));
  });

  it('changes when the bytes change', () => {
    const file = stage('bill.pdf', 'v1');
    const before = cacheKey(file.localPath, file.bytes, file.abs);
    fs.writeFileSync(file.abs, 'v2-longer');
    expect(cacheKey(file.localPath, 'v2-longer'.length, file.abs)).not.toBe(before);
  });

  it('separates two files with identical content under different messages', () => {
    // A re-sent identical file is a new message, and the topic decision has to
    // see it as one.
    const a = stage('bill.pdf', 'same');
    const bLocal = 'inbox/msg-2/bill.pdf';
    const bAbs = path.join(workspace, bLocal);
    fs.mkdirSync(path.dirname(bAbs), { recursive: true });
    fs.writeFileSync(bAbs, 'same');

    expect(cacheKey(a.localPath, a.bytes, a.abs)).not.toBe(cacheKey(bLocal, 4, bAbs));
  });

  it('still produces a key for a file that has vanished', () => {
    expect(cacheKey('inbox/msg-1/gone.pdf', 10, path.join(workspace, 'nope'))).toHaveLength(32);
  });
});

describe('readCached / writeCached', () => {
  it('round-trips a digest through memory', () => {
    writeCached('k1', digest());
    expect(readCached('k1')?.text).toBe('Amount due €42.00');
  });

  it('round-trips through disk after the process forgets', () => {
    // What survives a container swap: the host sweep resets `processing` rows
    // and the replacement container replays the same batch.
    writeCached('k2', digest());
    resetAttachmentCacheForTests();
    expect(readCached('k2')?.tool).toBe('pdftotext');
  });

  it('returns null for an unknown key', () => {
    expect(readCached('never-written')).toBeNull();
  });

  it('writes the full text to a .txt sidecar named after the source', () => {
    const stored = writeCached('k3', digest({ name: 'blackwater-water-invoice.pdf' }), 'the whole document text');

    expect(stored.textPath).toBeDefined();
    expect(path.basename(stored.textPath!)).toBe('blackwater-water-invoice.txt');
    expect(fs.readFileSync(stored.textPath!, 'utf-8')).toBe('the whole document text');
  });

  it('writes no sidecar when there is no text', () => {
    expect(writeCached('k4', digest({ text: null })).textPath).toBeUndefined();
    expect(writeCached('k5', digest(), '   ').textPath).toBeUndefined();
  });

  it('drops a textPath whose sidecar was pruned, so the agent never gets a dead path', () => {
    const stored = writeCached('k6', digest(), 'full text');
    fs.rmSync(stored.textPath!);
    resetAttachmentCacheForTests();

    const reread = readCached('k6');
    expect(reread).not.toBeNull();
    expect(reread!.textPath).toBeUndefined();
    expect(reread!.text).toBe('Amount due €42.00');
  });

  it('still returns a working digest when the cache dir cannot be written', () => {
    const root = cacheRoot();
    fs.mkdirSync(path.dirname(root), { recursive: true });
    // A file where the directory should be: every write below fails.
    fs.writeFileSync(root, 'not a directory');

    const stored = writeCached('k7', digest(), 'full text');
    expect(stored.text).toBe('Amount due €42.00');
    expect(stored.textPath).toBeUndefined();
    expect(readCached('k7')?.text).toBe('Amount due €42.00');
  });
});
