import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), config: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawn: mocks.spawn }));
vi.mock('./app-bundle.js', () => ({ getAppBundleExecutable: () => '/test/Luna.app/Contents/MacOS/luna' }));
vi.mock('./config.js', () => ({
  loadAppleConfig: mocks.config,
  isAppEnabled: (config: { enabled: boolean }, app: string) => config.enabled && app === 'messages',
}));
vi.mock('./paths.js', () => ({ resolveAppleHealthPath: () => '/test/apple-health.json' }));

import type { AppHealth, AppleHealth } from './permissions.js';
import { startApplePermissionRecovery } from './permission-recovery.js';

const initial: AppHealth = { status: 'denied', message: 'Access denied', checkedAt: '2026-01-01T00:00:00Z' };
const granted: AppHealth = { status: 'ok', message: 'Access OK', checkedAt: '2026-01-01T00:01:00Z' };
let cache: Partial<AppleHealth>;
let stop: (() => void) | undefined;

function returnProbe(result: AppHealth): void {
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, { stdout: JSON.stringify({ messages: result }), stderr: '' });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cache = { messages: initial };
  mocks.config.mockReturnValue({ enabled: true });
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => JSON.stringify(cache));
  vi.spyOn(fs, 'writeFileSync').mockImplementation((_file, data) => {
    cache = JSON.parse(String(data)) as Partial<AppleHealth>;
  });
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  returnProbe({ ...initial, checkedAt: granted.checkedAt });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('Apple permission recovery', () => {
  it('does not poll or redeploy when startup permissions are healthy', async () => {
    stop = startApplePermissionRecovery({ messages: granted } as AppleHealth, ['messages']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('keeps checking a denied permission without redeploying', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(cache.messages?.status).toBe('denied');
  });

  it('redeploys once after the foreground primer reports a new grant', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    cache = { messages: granted };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('/dist/cli/client.js'), 'redeploy', '--no-build'],
      expect.objectContaining({ detached: true }),
    );
  });

  it('uses a fresh bundle process to detect a Full Disk Access grant', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    returnProbe(granted);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/test/Luna.app/Contents/MacOS/luna',
      [expect.stringContaining('/permission-check.js'), 'messages'],
      expect.objectContaining({ timeout: 35_000 }),
      expect.any(Function),
    );
    expect(cache.messages).toEqual(granted);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an old cached success for a new grant', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    cache = { messages: { ...granted, checkedAt: '2025-12-31T00:00:00Z' } };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('retains a grant written by the primer during a slower denied probe', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      cache = { messages: granted };
      callback(null, { stdout: JSON.stringify({ messages: initial }), stderr: '' });
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cache.messages).toEqual(granted);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not restart on probe failures and retries the check later', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error('timeout')));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cache.messages).toEqual(initial);
    expect(mocks.spawn).not.toHaveBeenCalled();
    returnProbe(granted);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('stops watching when the user disables the builtin', async () => {
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    mocks.config.mockReturnValue({ enabled: false });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('coalesces checks and ignores a grant returned after shutdown', async () => {
    let finish!: (err: null, result: { stdout: string; stderr: string }) => void;
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      finish = callback;
    });
    stop = startApplePermissionRecovery(cache as AppleHealth, ['messages']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    stop();
    finish(null, { stdout: JSON.stringify({ messages: granted }), stderr: '' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(cache.messages).toEqual(initial);
  });
});
