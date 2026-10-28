import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSync = vi.fn();
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: (...args: unknown[]) => execSync(...args),
}));

const { runDevBuild } = await import('./dev-build.js');

describe('runDevBuild host step', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-dev-build-'));
    execSync.mockReset();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('compiles the host in a source checkout', () => {
    const result = runDevBuild({ projectRoot: root, container: false });
    expect(execSync).toHaveBeenCalledWith('pnpm run build', expect.objectContaining({ cwd: root }));
    expect(result.host_ok).toBe(true);
  });

  it('keeps the shipped host in a packaged install, which has no dev types to compile with', () => {
    fs.writeFileSync(path.join(root, '.luna-package-version'), '0.0.0\n');
    const result = runDevBuild({ projectRoot: root, container: false });
    expect(execSync).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
