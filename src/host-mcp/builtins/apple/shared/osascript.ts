/**
 * AppleScript helper for permission probes and leftover Automation TCC checks.
 *
 * Calendar and Reminders go through EventKit (`calendar-helper`). Notes /
 * Contacts / Messages still use AppleScript/Automation, so probes here remain
 * useful for the Luna `.app` permission primer.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function isAutomationDenied(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('not authorized') ||
    s.includes('not allowed') ||
    s.includes('-1743') || // errAEEventNotPermitted
    s.includes('oserror: -1743') ||
    s.includes('application is not running') ||
    (s.includes('access') && s.includes('denied'))
  );
}

/** Run an AppleScript and return trimmed stdout. */
export async function runOsascript(script: string, timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return String(stdout ?? '').trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    const stderr = String(e.stderr ?? e.message ?? err);
    if (isAutomationDenied(stderr)) {
      throw new Error(`Not authorized to send Apple events: ${stderr.trim()}`, { cause: err });
    }
    throw new Error(stderr.trim() || String(err), { cause: err });
  }
}
