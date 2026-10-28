import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Platform = 'macos' | 'linux' | 'unknown';
export type ServiceManager = 'launchd' | 'none';

const platforms: Partial<Record<NodeJS.Platform, Platform>> = { darwin: 'macos', linux: 'linux' };
export const getPlatform = (): Platform => platforms[os.platform()] ?? 'unknown';
export const isRoot = (): boolean => process.getuid?.() === 0;
export const getServiceManager = (): ServiceManager => getPlatform() === 'macos' ? 'launchd' : 'none';
export const getNodePath = (): string => process.execPath;
export const getNodeVersion = (): string => process.versions.node;
export const getNodeMajorVersion = (): number => Number(process.versions.node.split('.')[0]);

export function commandExists(command: string): boolean {
  if (!command || /[\/\\\0]/.test(command)) return false;
  return (process.env.PATH ?? '').split(path.delimiter).some((directory) => {
    try {
      const file = path.join(directory || '.', command);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

