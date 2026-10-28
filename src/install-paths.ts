import fs from 'fs';
import os from 'os';
import path from 'path';

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** Install agent workspace directory (respects `process.cwd()` for setup/tests). */
export function getAgentDir(): string {
  return path.resolve(process.cwd(), 'agent');
}

export function getMountAllowlistPath(): string {
  return path.join(homeDir(), '.config', 'luna', 'mount-allowlist.json');
}

/**
 * True for an install materialized from the npm package (`~/.luna`). Its `dist/` ships prebuilt
 * and is refreshed by the launcher; the package carries no dev types, so it must not run `tsc`.
 */
export function isPackagedInstall(root: string = process.cwd()): boolean {
  return fs.existsSync(path.join(root, '.luna-package-version'));
}
