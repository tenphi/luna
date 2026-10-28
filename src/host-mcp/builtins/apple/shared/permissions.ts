/**
 * Permission probes for the in-tree Apple builtin.
 *
 * Calendar and Reminders use EventKit via the vendored `calendar-helper` (fast).
 * Notes / Contacts / Messages probe via AppleScript / filesystem access so the
 * Luna .app primer can trigger the one-time TCC dialogs.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';

import type { AppleAppId } from './config.js';
import { isLaunchdLikeSession } from './launch-context.js';
import { runOsascript } from './osascript.js';
import { resolveAppleHealthPath, ensureAppleDataDir, resolveCalendarHelper } from './paths.js';

const execFileAsync = promisify(execFile);

export type HealthStatus = 'ok' | 'denied' | 'missing_cli' | 'disabled' | 'error';

export interface AppHealth {
  status: HealthStatus;
  message: string;
  checkedAt: string;
}

export type AppleHealth = Record<AppleAppId, AppHealth>;

function classifyError(err: unknown): { status: HealthStatus; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes('not authorized') ||
    lower.includes('permission') ||
    lower.includes('denied') ||
    lower.includes('tcc') ||
    lower.includes('access') ||
    lower.includes('-1743')
  ) {
    return { status: 'denied', message: msg };
  }
  return { status: 'error', message: msg };
}

async function runCalendarHelper(args: string[]): Promise<string> {
  const helper = resolveCalendarHelper();
  try {
    const { stdout, stderr } = await execFileAsync(helper, args, {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
    const out = (stdout || '').trim();
    if (out.startsWith('{') && out.includes('"error"')) {
      const parsed = JSON.parse(out) as { error?: string };
      if (parsed.error) throw new Error(parsed.error);
    }
    if (!out && stderr) throw new Error(stderr.trim());
    return out || 'ok';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (e.code === 'ENOENT') {
      throw Object.assign(
        new Error('calendar-helper not found (run scripts/build-calendar-helper.sh)', { cause: err }),
        { code: 'ENOENT' },
      );
    }
    const fromStdout = typeof e.stdout === 'string' ? e.stdout.trim() : '';
    if (fromStdout.startsWith('{')) {
      try {
        const parsed = JSON.parse(fromStdout) as { error?: string };
        if (parsed.error) throw new Error(parsed.error, { cause: err });
      } catch (inner) {
        if (inner instanceof Error && inner.message !== fromStdout) throw inner;
      }
    }
    throw new Error(fromStdout || e.stderr?.trim() || e.message || String(err), { cause: err });
  }
}

export async function probeApp(app: AppleAppId): Promise<AppHealth> {
  const checkedAt = new Date().toISOString();

  const probes: Record<AppleAppId, () => Promise<string>> = {
    calendar: async () => {
      // EventKit via the vendored calendar-helper — the fast path. Requires the
      // Luna .app bundle TCC grant (NSCalendarsUsageDescription).
      const out = await runCalendarHelper(['list-calendars']);
      if (!out || out === '[]' || out === 'ok') return 'Calendar EventKit access OK';
      return 'Calendar EventKit access OK';
    },
    reminders: async () => {
      // EventKit via the vendored calendar-helper. Requires the Luna .app
      // bundle TCC grant (NSRemindersUsageDescription / Full Access).
      const out = await runCalendarHelper(['list-reminder-lists']);
      if (!out || out === '[]' || out === 'ok') return 'Reminders EventKit access OK';
      return 'Reminders EventKit access OK';
    },
    notes: async () => {
      // An Automation probe needs an Apple event, not a populated or synced library.
      await runOsascript(`tell application "Notes" to get name`, 30_000);
      return 'Notes Automation access OK';
    },
    contacts: async () => {
      await runOsascript(`tell application "Contacts" to get name`, 30_000);
      return 'Contacts Automation access OK';
    },
    messages: async () => {
      const db = `${process.env.HOME}/Library/Messages/chat.db`;
      try {
        // Opening the file checks the same protected-file access the Messages
        // server needs; checking its mode bits alone cannot establish FDA.
        const fd = fs.openSync(db, 'r');
        fs.closeSync(fd);
      } catch (err) {
        // A missing store or unrelated IO error is not a permission denial.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EACCES') throw err;
        throw new Error(
          'Cannot read ~/Library/Messages/chat.db — grant Full Disk Access to the Luna app in System Settings > Privacy & Security > Full Disk Access',
          { cause: err },
        );
      }
      await runOsascript(`tell application "Messages" to get name`, 15_000);
      return 'Messages access OK (chat.db readable + Automation)';
    },
  };

  try {
    const message = await probes[app]();
    return { status: 'ok', message, checkedAt };
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT' || (err instanceof Error && err.message.includes('not found'))) {
      return {
        status: 'missing_cli',
        message: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
    const { status, message } = classifyError(err);
    if (status === 'denied' && isLaunchdLikeSession()) {
      return {
        status,
        message: `${message}\n\nRun: luna setup step apple\nThen allow the prompts when Luna opens, and grant Full Disk Access for Messages if needed.`,
        checkedAt,
      };
    }
    return { status, message, checkedAt };
  }
}

export async function runPermissionDryRun(
  apps: AppleAppId[],
  disabledApps: Set<AppleAppId> = new Set(),
): Promise<AppleHealth> {
  const health: Partial<AppleHealth> = {};

  for (const app of apps) {
    if (disabledApps.has(app)) {
      health[app] = {
        status: 'disabled',
        message: 'Disabled in Apple config',
        checkedAt: new Date().toISOString(),
      };
      continue;
    }
    health[app] = await probeApp(app);
  }

  const full = health as AppleHealth;
  ensureAppleDataDir();
  fs.writeFileSync(resolveAppleHealthPath(), JSON.stringify(full, null, 2) + '\n');
  return full;
}
