import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { commandExists, getNodeMajorVersion, getNodePath, getNodeVersion, getPlatform, getServiceManager } from './platform.js';

afterEach(() => vi.restoreAllMocks());

it.each(['linux', 'win32'] as const)('does not offer a host service on %s', (platform) => {
  vi.spyOn(os, 'platform').mockReturnValue(platform);
  expect(getServiceManager()).toBe('none');
});

it('uses launchd and the running Node executable on macOS', () => {
  vi.spyOn(os, 'platform').mockReturnValue('darwin');
  expect(getPlatform()).toBe('macos');
  expect(getServiceManager()).toBe('launchd');
  expect(getNodePath()).toBe(process.execPath);
  expect(getNodeVersion()).toBe(process.versions.node);
  expect(getNodeMajorVersion()).toBe(Number(process.versions.node.split('.')[0]));
});

it('checks executables without interpreting command syntax', () => {
  expect(commandExists('node')).toBe(true);
  expect(commandExists('luna-missing-executable')).toBe(false);
  expect(commandExists('node; true')).toBe(false);
  expect(commandExists('../node')).toBe(false);
});
