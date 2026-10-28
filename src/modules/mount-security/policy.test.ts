import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ file: '' }));
vi.mock('../../install-paths.js', () => ({ getMountAllowlistPath: () => config.file }));
vi.mock('../../log.js', () => ({ log: { warn: vi.fn() } }));
let directory: string;
beforeEach(() => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-policy-contract-'));
  config.file = path.join(directory, 'policy.json');
  fs.mkdirSync(path.join(directory, 'allowed'));
  fs.mkdirSync(path.join(directory, 'outside'));
});
afterEach(() => fs.rmSync(directory, { recursive: true }));
const source = (name = 'allowed') => path.join(directory, name);
function policy(writable = false): void {
  fs.writeFileSync(
    config.file,
    JSON.stringify({ allowedRoots: [{ path: source(), allowReadWrite: writable }], blockedPatterns: ['excluded'] }),
  );
}
it('retries missing policy but permanently rejects malformed policy', async () => {
  const mounts = await import('./index.js');
  expect(mounts.validateMount({ hostPath: source() }).allowed).toBe(false);
  policy();
  expect(mounts.validateMount({ hostPath: source() }).allowed).toBe(true);
  vi.resetModules();
  fs.writeFileSync(
    config.file,
    JSON.stringify({ allowedRoots: [{ path: source(), allowReadWrite: 'yes' }], blockedPatterns: [] }),
  );
  const invalid = await import('./index.js');
  expect(invalid.loadMountAllowlist()).toBeNull();
  policy(true);
  expect(invalid.loadMountAllowlist()).toBeNull();
});
it('requires both the request and policy to permit writes', async () => {
  policy(true);
  const mounts = await import('./index.js');
  expect(mounts.validateMount({ hostPath: source() }).effectiveReadonly).toBe(true);
  expect(mounts.validateMount({ hostPath: source(), readonly: false }).effectiveReadonly).toBe(false);
  expect(mounts.validateAdditionalMounts([{ hostPath: source(), containerPath: 'notes' }], 'synthetic')).toEqual([
    { hostPath: fs.realpathSync(source()), containerPath: '/workspace/extra/notes', readonly: true },
  ]);
});
it('blocks symlink escapes, secret directories, and dangerous container destinations', async () => {
  policy();
  fs.symlinkSync(source('outside'), source('allowed/link'));
  fs.mkdirSync(source('allowed/.ssh'));
  const { validateMount } = await import('./index.js');
  for (const hostPath of [source('allowed/link'), source('allowed/.ssh'), source('outside')])
    expect(validateMount({ hostPath }).allowed).toBe(false);
  for (const containerPath of ['../escape', '/absolute', 'name:rw', '..', 'bad\npath', '']) {
    expect(validateMount({ hostPath: source(), containerPath }).allowed).toBe(false);
  }
  expect(validateMount({ hostPath: source(), readonly: false }).effectiveReadonly).toBe(true);
});
