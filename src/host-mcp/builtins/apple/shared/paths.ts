import fs from 'fs';
import path from 'path';

import { getInstallSlug } from '../../../../install-slug.js';

const PROJECT_ROOT = process.cwd();

export function resolveAppleDataDir(): string {
  return path.resolve(PROJECT_ROOT, 'data', 'apple');
}

export function resolveAppleHealthPath(): string {
  return path.join(resolveAppleDataDir(), 'health.json');
}

export function ensureAppleDataDir(): string {
  const dir = resolveAppleDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Path to the vendored, committed EventKit Swift helper (universal Mach-O).
 * Built from `native/CalendarHelper.swift` via `scripts/build-calendar-helper.sh`.
 */
export function resolveNativeCalendarHelper(projectRoot: string = PROJECT_ROOT): string {
  return path.join(projectRoot, 'src', 'host-mcp', 'builtins', 'apple', 'native', 'calendar-helper');
}

/**
 * Resolve the calendar-helper binary to invoke. Prefer the copy embedded in the
 * Luna `.app` bundle (so EventKit TCC attributes to the stable bundle identity);
 * fall back to the vendored native binary otherwise.
 */
export function resolveCalendarHelper(projectRoot: string = PROJECT_ROOT): string {
  const bundled = path.join(
    projectRoot,
    'data',
    'mac-app',
    `Luna-${getInstallSlug(projectRoot)}.app`,
    'Contents',
    'MacOS',
    'calendar-helper',
  );
  if (fs.existsSync(bundled)) return bundled;
  return resolveNativeCalendarHelper(projectRoot);
}
