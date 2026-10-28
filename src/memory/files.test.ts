import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', session: '', read: vi.fn() }));
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js');
  return {
    ...actual,
    retryRead: (work: (client: unknown) => unknown) =>
      work({
        hello: { akno_path: state.root },
        read: state.read,
      }),
  };
});
vi.mock('../session-manager.js', () => ({
  sessionDir: (group: string, session: string) => path.join(state.session, group, session),
}));

import { MemoryUnavailable } from './client.js';
import { stageMemoryFile } from './files.js';

let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memory-send-'));
  state.root = path.join(temp, 'memory');
  state.session = path.join(temp, 'sessions');
  fs.mkdirSync(state.root);
  state.read.mockReset();
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function original(rel: string, bytes: Buffer) {
  const file = path.join(state.root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { id: `doc-${path.basename(rel)}`, rel_path: rel, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const output = (id: string, name: string) => path.join(state.session, 'group', 'session', 'outbox', id, name);

describe('sending original memory files through the host', () => {
  it('stages distinct original bytes by document id or legacy memory path without a container memory mount', async () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x80]);
    const pdf = Buffer.from('%PDF-1.7\nexample original\n%%EOF');
    const first = original('people/example/scan.jpg', image);
    const second = original('documents/example/scan.pdf', pdf);
    state.read.mockImplementation(async ({ document }) => ({
      status: 'ok',
      document: document === first.id ? first : second,
    }));

    expect(await stageMemoryFile('group', 'session', first.id, 'msg-1')).toEqual({ filename: 'scan.jpg' });
    expect(await stageMemoryFile('group', 'session', `memory:${second.rel_path}`, 'msg-2', 'copy.pdf')).toEqual({
      filename: 'copy.pdf',
    });
    expect(state.read).toHaveBeenNthCalledWith(2, { document: second.rel_path });
    expect(fs.readFileSync(output('msg-1', 'scan.jpg'))).toEqual(image);
    expect(fs.readFileSync(output('msg-2', 'copy.pdf'))).toEqual(pdf);
  });

  it('can send an original with no extracted text', async () => {
    state.read.mockResolvedValue({
      status: 'degraded',
      document: original('photo.jpg', Buffer.from('image')),
      text: null,
    });
    expect(await stageMemoryFile('group', 'session', 'doc-photo', 'msg-1')).toEqual({ filename: 'photo.jpg' });
  });

  it('refuses a missing original even when memory still has its text', async () => {
    const doc = original('scan.pdf', Buffer.from('original'));
    fs.unlinkSync(path.join(state.root, doc.rel_path));
    state.read.mockResolvedValue({ status: 'unavailable', document: { ...doc, text: 'retained text' } });
    expect(await stageMemoryFile('group', 'session', doc.id, 'msg-1')).toEqual({
      error: 'The original file is missing; stored text alone cannot be sent as the original.',
    });
    expect(fs.existsSync(output('msg-1', 'scan.pdf'))).toBe(false);
  });

  it('refuses changed and oversized originals before staging', async () => {
    const doc = original('scan.pdf', Buffer.from('original'));
    state.read.mockResolvedValue({ status: 'ok', document: doc });
    fs.writeFileSync(path.join(state.root, doc.rel_path), 'changed');
    expect(await stageMemoryFile('group', 'session', doc.id, 'msg-1')).toMatchObject({
      error: expect.stringContaining('has changed'),
    });
    fs.truncateSync(path.join(state.root, doc.rel_path), 51 * 1024 * 1024);
    expect(await stageMemoryFile('group', 'session', doc.id, 'msg-1')).toMatchObject({
      error: expect.stringContaining('50MB'),
    });
    expect(fs.existsSync(output('msg-1', 'scan.pdf'))).toBe(false);
  });

  it.each(['../outside.pdf', '/tmp/outside.pdf', '.akno/private.json'])(
    'refuses unsafe indexed path %s',
    async (rel) => {
      state.read.mockResolvedValue({ status: 'ok', document: { rel_path: rel } });
      expect(await stageMemoryFile('group', 'session', 'doc-example', 'msg-1')).toMatchObject({
        error: expect.stringContaining('outside'),
      });
    },
  );

  it('refuses source and outbox symlink escapes', async () => {
    const doc = original('scan.pdf', Buffer.from('original'));
    state.read.mockResolvedValue({ status: 'ok', document: doc });
    fs.mkdirSync(path.dirname(output('msg-1', 'scan.pdf')), { recursive: true });
    fs.symlinkSync(temp, output('msg-1', 'link'));
    // An existing output leaf may not be a symlink outside the session either.
    fs.symlinkSync(path.join(temp, 'outside.pdf'), output('msg-1', 'scan.pdf'));
    expect(await stageMemoryFile('group', 'session', doc.id, 'msg-1')).toMatchObject({
      error: expect.stringContaining('outbox'),
    });
    expect(fs.existsSync(path.join(temp, 'outside.pdf'))).toBe(false);
    fs.writeFileSync(path.join(temp, 'outside.pdf'), 'external');
    fs.unlinkSync(path.join(state.root, doc.rel_path));
    fs.symlinkSync(path.join(temp, 'outside.pdf'), path.join(state.root, doc.rel_path));
    expect(await stageMemoryFile('group', 'session', doc.id, 'msg-2')).toMatchObject({
      error: expect.stringContaining('outside'),
    });
  });

  it('rejects traversal in output names and session identity', async () => {
    expect(await stageMemoryFile('group', 'session', 'doc-example', '../escape')).toMatchObject({
      error: expect.any(String),
    });
    expect(await stageMemoryFile('group', 'session', 'doc-example', 'msg-1', '../escape')).toMatchObject({
      error: expect.any(String),
    });
    expect(state.read).not.toHaveBeenCalled();
    state.read.mockResolvedValue({ status: 'ok', document: original('scan.pdf', Buffer.from('original')) });
    expect(await stageMemoryFile('group', '../other-session', 'doc-example', 'msg-1')).toMatchObject({
      error: expect.stringContaining('outbox'),
    });
  });

  it('reports unavailable memory and hides host paths in service errors', async () => {
    state.read.mockRejectedValue(new MemoryUnavailable(`offline at ${temp}`));
    expect(await stageMemoryFile('group', 'session', 'doc-example', 'msg-1')).toMatchObject({
      error: expect.stringContaining('Memory is unavailable'),
    });
    state.read.mockRejectedValue(new Error(`ambiguous document in ${state.root}`));
    const result = await stageMemoryFile('group', 'session', 'scan.pdf', 'msg-1');
    expect(result).toMatchObject({ error: expect.stringContaining('unique document id') });
    expect(JSON.stringify(result)).not.toContain(temp);
  });
});
