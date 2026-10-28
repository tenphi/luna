import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPackagedInstall } from '../src/install-paths.js';
import { getLaunchdLabel } from '../src/install-slug.js';
import { log } from '../src/log.js';
import { ensureLaunchdHostProgram } from './macos-app-bundle.js';
import { cleanupUnhealthyPeers } from './peer-cleanup.js';
import { getNodePath, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}
function element(value: string | boolean | string[] | Record<string, string>): string {
  if (typeof value === 'boolean') return `<${value}/>`;
  if (typeof value === 'string') return `<string>${xml(value)}</string>`;
  if (Array.isArray(value)) return `<array>${value.map(element).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, item]) => `<key>${xml(key)}</key>${element(item)}`).join('')}</dict>`;
}

export function buildLaunchdPlist(root: string, home: string, program: { executable: string; hostScript: string }): string {
  const settings = {
    Label: getLaunchdLabel(root),
    ProgramArguments: [program.executable, program.hostScript],
    WorkingDirectory: root,
    RunAtLoad: true,
    KeepAlive: true,
    EnvironmentVariables: { HOME: home, PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${home}/.local/bin` },
    StandardOutPath: path.join(root, 'logs', 'luna.log'),
    StandardErrorPath: path.join(root, 'logs', 'luna.error.log'),
  };
  const pairs = Object.entries(settings).map(([key, value]) => `<key>${key}</key>${element(value)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${pairs}\n</dict></plist>\n`;
}

function linkCli(root: string, home: string): void {
  const destination = path.join(home, '.local', 'bin', 'luna');
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let existing: fs.Stats | undefined;
    try { existing = fs.lstatSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing && !existing.isSymbolicLink()) {
      log.warn('CLI link destination is an existing file', { destination });
      return;
    }
    if (existing) fs.unlinkSync(destination);
    fs.symlinkSync(path.join(root, 'bin', 'luna'), destination);
  } catch (error) {
    log.warn('Could not create the optional CLI shortcut', { error });
  }
}

export async function run(_args: string[]): Promise<void> {
  if (getPlatform() !== 'macos') throw new Error('Luna host services require macOS');
  const root = process.cwd();
  const home = os.homedir();
  const node = getNodePath();
  const label = getLaunchdLabel(root);
  const filename = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    if (!isPackagedInstall(root)) execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  } catch (error) {
    emitStatus('SETUP_SERVICE', { STATUS: 'failed', ERROR: 'build_failed', NODE_PATH: node, PROJECT_PATH: root });
    throw error;
  }
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const peers = cleanupUnhealthyPeers(root);
  if (peers.unloaded.length) log.warn('Stopped unhealthy sibling services', { count: peers.unloaded.length });
  const program = ensureLaunchdHostProgram(root, node);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, buildLaunchdPlist(root, home, program));
  try { execFileSync('/bin/launchctl', ['unload', filename], { stdio: 'ignore' }); } catch { /* A fresh install has nothing to unload. */ }
  execFileSync('/bin/launchctl', ['load', filename], { stdio: 'pipe' });
  const listing = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' });
  const loaded = listing.split('\n').some((line) => line.trim().split(/\s+/).at(-1) === label);
  linkCli(root, home);
  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd', SERVICE_LABEL: label, NODE_PATH: node, PROJECT_PATH: root,
    PLIST_PATH: filename, SERVICE_LOADED: loaded, STATUS: loaded ? 'success' : 'failed', LOG: 'logs/setup.log',
  });
  if (!loaded) throw new Error('launchd did not register the Luna service');
}
