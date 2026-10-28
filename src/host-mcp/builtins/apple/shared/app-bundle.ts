/**
 * Generate a minimal `.app` bundle that launches Luna, giving the launchd
 * process a STABLE bundle identity for macOS TCC (Calendar EventKit /
 * Automation).
 *
 * Why: TCC keys EventKit grants to the *responsible process*. A raw launchd
 * ProgramArguments of `node dist/index.js` is attributed to the (adhoc /
 * version-specific) node binary, which has no stable identity and often can't
 * display the TCC prompt from a LaunchAgent.
 *
 * Wrapping in a `.app` with a fixed CFBundleIdentifier + a real Mach-O
 * executable (not a bash script — scripts break EventKit attribution) gives
 * TCC a stable, GUI-attachable identity. launchd runs that executable; GUI
 * `open -a` with no args runs the permission primer so the prompt can appear.
 */
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInstallSlug } from '../../../../install-slug.js';
import { resolveNativeSpeechHelper } from '../../../../voice/macos.js';
import { resolveNativeCalendarHelper } from './paths.js';

export function getAppBundleId(projectRoot: string): string {
  return `com.luna.agent-${getInstallSlug(projectRoot)}`;
}

export function getAppBundleName(projectRoot: string): string {
  return `Luna-${getInstallSlug(projectRoot)}`;
}

/** Path to the generated `.app` bundle (under the project, gitignored via data/). */
export function getAppBundlePath(projectRoot: string): string {
  return path.join(projectRoot, 'data', 'mac-app', `${getAppBundleName(projectRoot)}.app`);
}

/** Path to the executable inside the bundle that launchd should run. */
export function getAppBundleExecutable(projectRoot: string): string {
  return path.join(getAppBundlePath(projectRoot), 'Contents', 'MacOS', 'luna');
}

/**
 * Ensure the Luna `.app` exists and return launchd ProgramArguments for host
 * mode: `[appExecutable, dist/index.js]`. Never launch bare `node` from launchd
 * — TCC (EventKit / Automation / Full Disk Access) must attribute to the
 * stable bundle identity.
 */
export function ensureLaunchdHostProgram(
  projectRoot: string,
  nodePath: string = process.execPath,
): { executable: string; hostScript: string } {
  const executable = ensureAppBundle(projectRoot, nodePath);
  const hostScript = path.join(projectRoot, 'dist', 'index.js');
  return { executable, hostScript };
}

/** XML fragment for launchd ProgramArguments (app launcher + host script). */
export function launchdHostProgramArgumentsXml(projectRoot: string, nodePath: string = process.execPath): string {
  const { executable, hostScript } = ensureLaunchdHostProgram(projectRoot, nodePath);
  return `    <key>ProgramArguments</key>
    <array>
        <string>${executable}</string>
        <string>${hostScript}</string>
    </array>`;
}

/**
 * Ensure an existing LaunchAgent plist targets the Luna `.app` (not bare node).
 * Returns whether the file was rewritten.
 */
export function ensureLaunchdPlistUsesAppBundle(
  plistPath: string,
  projectRoot: string,
  nodePath: string = process.execPath,
): { rewritten: boolean; executable: string } {
  const argsXml = launchdHostProgramArgumentsXml(projectRoot, nodePath);
  const executable = getAppBundleExecutable(projectRoot);
  if (!fs.existsSync(plistPath)) {
    return { rewritten: false, executable };
  }
  const before = fs.readFileSync(plistPath, 'utf-8');
  if (before.includes(`<string>${executable}</string>`) && before.includes(`${path.sep}dist${path.sep}index.js`)) {
    // Already app-launched; still refresh the bundle Mach-O (node path / primer).
    ensureAppBundle(projectRoot, nodePath);
    return { rewritten: false, executable };
  }
  const after = before.replace(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/, argsXml.trim());
  if (after === before) {
    ensureAppBundle(projectRoot, nodePath);
    return { rewritten: false, executable };
  }
  fs.writeFileSync(plistPath, after);
  return { rewritten: true, executable };
}

function compileMachOLauncher(outPath: string, nodePath: string, primerPath: string, stampPath: string): void {
  // IMPORTANT: use fork+exec (not execv alone). Full Disk Access is granted to
  // the Luna.app Mach-O identity; execv into node replaces that identity so
  // Messages chat.db stays EPERM. A surviving parent Luna process lets the
  // child node inherit FDA (same pattern as spawning calendar-helper).
  const src = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int run_node(char *const args[]) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 127;
  }
  if (pid == 0) {
    execv(args[0], args);
    perror("execv");
    _exit(127);
  }
  int status = 0;
  if (waitpid(pid, &status, 0) < 0) {
    perror("waitpid");
    return 127;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 127;
}

int main(int argc, char **argv) {
  const char *node = ${JSON.stringify(nodePath)};
  const char *primer = ${JSON.stringify(primerPath)};

  if (argc <= 1) {
    char *args[] = { (char *)node, (char *)primer, NULL };
    return run_node(args);
  }

  char **args = calloc((size_t)argc + 1, sizeof(char *));
  if (!args) return 127;
  args[0] = (char *)node;
  for (int i = 1; i < argc; i++) args[i] = argv[i];
  args[argc] = NULL;
  int code = run_node(args);
  free(args);
  return code;
}
`;
  // Ad-hoc TCC grants include the executable's code hash. Recompiling the same
  // launcher can change its code hash and invalidate Full Disk Access, even
  // though the bundle identifier is unchanged. Keep an unchanged launcher.
  // The stamp lives outside the signed bundle so it cannot change its seal.
  const sourceHash = createHash('sha256').update(src).update('\0clang -O2').digest('hex');
  if (fs.existsSync(outPath) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === sourceHash) {
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-app-'));
  const cFile = path.join(tmpDir, 'luna-launcher.c');
  try {
    fs.writeFileSync(cFile, src);
    execSync(`clang -O2 -o ${JSON.stringify(outPath)} ${JSON.stringify(cFile)}`, { stdio: 'pipe' });
    fs.chmodSync(outPath, 0o755);
    fs.writeFileSync(stampPath, sourceHash);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Create / refresh the `.app` bundle. Idempotent. Returns the executable path
 * launchd should target. Signs ad-hoc with a stable identifier and preserves
 * unchanged launchers so their TCC code requirement survives restarts.
 */
export function ensureAppBundle(projectRoot: string, nodePath: string): string {
  const appPath = getAppBundlePath(projectRoot);
  const macosDir = path.join(appPath, 'Contents', 'MacOS');
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const bundleId = getAppBundleId(projectRoot);
  const name = getAppBundleName(projectRoot);

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // macOS 14+ uses Full Access usage strings; keep the legacy keys too.
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${name}</string>
    <key>CFBundleDisplayName</key>
    <string>Luna</string>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>
    <key>CFBundleExecutable</key>
    <string>luna</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>2.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSCalendarsUsageDescription</key>
    <string>Luna reads your Calendar to answer scheduling questions.</string>
    <key>NSCalendarsFullAccessUsageDescription</key>
    <string>Luna reads your Calendar to answer scheduling questions.</string>
    <key>NSRemindersUsageDescription</key>
    <string>Luna reads and creates Reminders on your behalf.</string>
    <key>NSRemindersFullAccessUsageDescription</key>
    <string>Luna reads and creates Reminders on your behalf.</string>
    <key>NSContactsUsageDescription</key>
    <string>Luna looks up Contacts when you ask about people.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Luna automates Apple apps (Notes, Messages, Contacts, Calendar) via Apple Events.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Luna transcribes the voice messages you send it, on this Mac.</string>
</dict>
</plist>`;

  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist);

  const primer = path.join(projectRoot, 'dist', 'host-mcp', 'builtins', 'apple', 'shared', 'permission-primer.js');
  const execFile = path.join(macosDir, 'luna');
  const launcherStamp = path.join(path.dirname(appPath), `${name}.launcher-source.sha256`);
  compileMachOLauncher(execFile, nodePath, primer, launcherStamp);

  // EventKit TCC keys off the *helper binary's path*. Copy the vendored
  // calendar-helper into this bundle so TCC attributes the grant to Luna.app.
  embedCalendarHelper(projectRoot, macosDir, bundleId);

  // Same bargain for Speech Recognition, which is attributed to the responsible process: run
  // from a bare launchd `node` there is no stable identity to hold the grant and no way to
  // raise the prompt at all.
  embedHelper(resolveNativeSpeechHelper(projectRoot), macosDir, 'speech-helper', bundleId);

  signAppBundle(appPath, bundleId);

  return execFile;
}

function signAppBundle(appPath: string, bundleId: string): void {
  // An actual launcher change can still require refreshing an existing TCC
  // grant because ad-hoc grants also bind its hash.
  try {
    execSync(`codesign --force --deep --sign - --identifier ${JSON.stringify(bundleId)} ${JSON.stringify(appPath)}`, {
      stdio: 'ignore',
    });
  } catch {
    // Non-fatal: bundle still works unsigned, TCC just uses the path identity.
  }
}

/**
 * Copy the vendored calendar-helper into the .app bundle. Idempotent. Safe to
 * call from a running host (does not rewrite the Luna launcher Mach-O).
 */
export function ensureCalendarHelperEmbedded(projectRoot: string = process.cwd()): string | null {
  const macosDir = path.join(getAppBundlePath(projectRoot), 'Contents', 'MacOS');
  if (!fs.existsSync(macosDir)) return null;
  const bundleId = getAppBundleId(projectRoot);
  if (embedCalendarHelper(projectRoot, macosDir, bundleId)) {
    signAppBundle(getAppBundlePath(projectRoot), bundleId);
  }
  const bundled = path.join(macosDir, 'calendar-helper');
  return fs.existsSync(bundled) ? bundled : null;
}

/**
 * Copy the vendored calendar-helper (native/calendar-helper) into the bundle
 * and ad-hoc-sign it so EventKit TCC attributes to Luna.app. Idempotent.
 */
function embedCalendarHelper(projectRoot: string, macosDir: string, bundleId: string): boolean {
  return embedHelper(resolveNativeCalendarHelper(projectRoot), macosDir, 'calendar-helper', bundleId);
}

/**
 * Copy one vendored native helper into the bundle and ad-hoc-sign it under a stable identifier,
 * so TCC attributes its grant to Luna.app rather than to a path that changes. Idempotent.
 */
function embedHelper(source: string, macosDir: string, name: string, bundleId: string): boolean {
  if (!fs.existsSync(source)) return false;

  const bundled = path.join(macosDir, name);
  // Signing changes the helper bytes, so compare its source fingerprint rather
  // than the signed binary with the source. Replacing an unchanged nested helper
  // at startup breaks the enclosing bundle's resource seal.
  const appPath = path.dirname(path.dirname(macosDir));
  const stampPath = path.join(path.dirname(appPath), `${path.basename(appPath)}.${name}-source.sha256`);
  const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (fs.existsSync(bundled) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === sourceHash) {
    return false;
  }
  fs.copyFileSync(source, bundled);
  fs.chmodSync(bundled, 0o755);
  try {
    execSync(
      `codesign --force --sign - --identifier ${JSON.stringify(`${bundleId}.${name}`)} ${JSON.stringify(bundled)}`,
      {
        stdio: 'ignore',
      },
    );
  } catch {
    /* non-fatal: TCC falls back to path identity */
  }
  fs.writeFileSync(stampPath, sourceHash);
  return true;
}
