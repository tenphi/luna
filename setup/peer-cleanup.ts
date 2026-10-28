import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLaunchdLabel } from '../src/install-slug.js';
export type PeerStatus = { label: string; configPath: string; state: string; runs: number; unhealthy: boolean };
export type PeerCleanupResult = {
  checked: PeerStatus[];
  unloaded: PeerStatus[];
  failures: { label: string; err: string }[];
};

// Older installations can repeatedly stop containers while crash-looping. Only loaded, unhealthy
// Luna launchd jobs are eligible; the current install and healthy peers remain available.
export function cleanupUnhealthyPeers(projectRoot = process.cwd()): PeerCleanupResult {
  const result: PeerCleanupResult = { checked: [], unloaded: [], failures: [] };
  if (os.platform() !== 'darwin') return result;
  const directory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return result;
  }
  const current = getLaunchdLabel(projectRoot);
  for (const entry of entries) {
    if (!/^com\.luna(?:-[a-f0-9]{8})?\.plist$/.test(entry)) continue;
    const label = entry.slice(0, -6);
    if (label === current) continue;
    const configPath = path.join(directory, entry);
    let output: string;
    try {
      output = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch {
      continue;
    }
    const state = /^\s*state\s*=\s*(\S+)/m.exec(output)?.[1] ?? 'unknown';
    const runs = Number(/^\s*runs\s*=\s*(\d+)/m.exec(output)?.[1] ?? 0);
    const status = { label, configPath, state, runs, unhealthy: state !== 'running' && runs > 10 };
    result.checked.push(status);
    if (!status.unhealthy) continue;
    try {
      execFileSync('launchctl', ['unload', configPath], { stdio: 'pipe' });
      result.unloaded.push(status);
    } catch (error) {
      result.failures.push({ label, err: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
