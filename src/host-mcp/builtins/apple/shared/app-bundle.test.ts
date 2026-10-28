import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('../../../../voice/macos.js', () => ({
  resolveNativeSpeechHelper: () => '/missing-test-helper',
}));

import { ensureAppBundle, ensureCalendarHelperEmbedded, ensureLaunchdPlistUsesAppBundle } from './app-bundle.js';

describe('Luna launcher identity', () => {
  let root: string;
  let builds: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-app-test-'));
    builds = 0;
    vi.mocked(execSync).mockImplementation((command) => {
      const output = String(command).match(/^clang -O2 -o ("(?:\\.|[^"])*") /);
      if (output) {
        builds++;
        fs.writeFileSync(JSON.parse(output[1]), `launcher-build-${builds}`);
      }
      return Buffer.from('');
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves the executable across repeated service restarts', () => {
    const executable = ensureAppBundle(root, '/test-runtime/node');
    const bytes = fs.readFileSync(executable);
    const plist = path.join(root, 'service.plist');
    fs.writeFileSync(
      plist,
      `<key>ProgramArguments</key><array><string>${executable}</string><string>${path.join(root, 'dist/index.js')}</string></array>`,
    );

    ensureLaunchdPlistUsesAppBundle(plist, root, '/test-runtime/node');
    ensureLaunchdPlistUsesAppBundle(plist, root, '/test-runtime/node');

    expect(builds).toBe(1);
    expect(fs.readFileSync(executable)).toEqual(bytes);
  });

  it('rebuilds when the configured Node executable changes', () => {
    const executable = ensureAppBundle(root, '/test-runtime/node');
    const bytes = fs.readFileSync(executable);
    ensureAppBundle(root, '/new-test-runtime/node');

    expect(builds).toBe(2);
    expect(fs.readFileSync(executable)).not.toEqual(bytes);
  });

  it('restores a missing executable even when its build stamp remains', () => {
    const executable = ensureAppBundle(root, '/test-runtime/node');
    fs.unlinkSync(executable);
    ensureAppBundle(root, '/test-runtime/node');

    expect(builds).toBe(2);
    expect(fs.existsSync(executable)).toBe(true);
  });

  it('preserves a signed nested helper during host startup', () => {
    const source = path.join(root, 'src/host-mcp/builtins/apple/native/calendar-helper');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'unsigned helper');
    const executable = ensureAppBundle(root, '/test-runtime/node');
    const bundled = path.join(path.dirname(executable), 'calendar-helper');
    fs.writeFileSync(bundled, 'signed helper bytes');
    vi.mocked(execSync).mockClear();

    ensureCalendarHelperEmbedded(root);

    expect(fs.readFileSync(bundled, 'utf8')).toBe('signed helper bytes');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('updates a changed helper and reseals the enclosing bundle', () => {
    const source = path.join(root, 'src/host-mcp/builtins/apple/native/calendar-helper');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'original helper');
    const executable = ensureAppBundle(root, '/test-runtime/node');
    fs.writeFileSync(source, 'updated helper');
    vi.mocked(execSync).mockClear();

    ensureCalendarHelperEmbedded(root);

    expect(fs.readFileSync(path.join(path.dirname(executable), 'calendar-helper'), 'utf8')).toBe('updated helper');
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('codesign --force --deep'), { stdio: 'ignore' });
  });
});
