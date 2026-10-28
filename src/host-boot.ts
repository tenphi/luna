/**
 * Host boot marker for stderr (`logs/luna.error.log`).
 *
 * launchd appends forever; health/`luna status` must not treat pre-restart
 * denials as current. Emit once at process start, then only score lines after
 * the latest marker.
 */
import fs from 'fs';

export const HOST_BOOT_MARKER_PREFIX = '[luna] host boot ';

/** Write a boot line to stderr (launchd StandardErrorPath → luna.error.log). */
export function markHostBoot(now = new Date()): void {
  process.stderr.write(`${HOST_BOOT_MARKER_PREFIX}${now.toISOString()}\n`);
}

/**
 * Keep log lines from the current host process only.
 * If no marker exists (pre-upgrade log), fall back to the last `legacyTail` lines.
 */
export function linesSinceLastHostBoot(allLines: string[], legacyTail = 40): string[] {
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (allLines[i]!.startsWith(HOST_BOOT_MARKER_PREFIX)) {
      return allLines.slice(i + 1);
    }
  }
  return allLines.slice(-legacyTail);
}

/** Read + scope an error log file to the current boot. */
export function readErrorLogSinceBoot(filePath: string, legacyTail = 40): string[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return linesSinceLastHostBoot(lines, legacyTail);
}
