/**
 * Host service control — launchd (macOS) and systemd (Linux).
 * Used by `luna service <verb>` and setup verification.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureLaunchdPlistUsesAppBundle } from '../host-mcp/builtins/apple/shared/app-bundle.js';
import { getLaunchdLabel, getSystemdUnit } from '../install-slug.js';

export type ServiceState = 'not_installed' | 'stopped' | 'running';

/** Keep launchd ProgramArguments on the Luna .app (never bare node) for TCC. */
function ensureLaunchdUsesAppBundle(projectRoot: string, plistPath: string): boolean {
  if (platform() !== 'macos') return false;
  const { rewritten } = ensureLaunchdPlistUsesAppBundle(plistPath, projectRoot);
  if (rewritten) {
    try {
      execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
    } catch {
      /* not loaded */
    }
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  }
  return rewritten;
}

export interface ServiceInfo {
  manager: 'launchd' | 'systemd' | 'none';
  label: string;
  plist_path?: string;
  unit?: string;
  state: ServiceState;
  pid: number | null;
  project_root: string;
}

function platform(): 'macos' | 'linux' | 'unknown' {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

function serviceManager(): ServiceInfo['manager'] {
  const p = platform();
  if (p === 'macos') return 'launchd';
  if (p === 'linux') {
    try {
      const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
      return init === 'systemd' ? 'systemd' : 'none';
    } catch {
      return 'none';
    }
  }
  return 'none';
}

function launchdPlistPath(projectRoot: string): string {
  const label = getLaunchdLabel(projectRoot);
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function guiDomain(): string {
  const uid = process.getuid?.() ?? 501;
  return `gui/${uid}`;
}

export function getServiceInfo(projectRoot: string = process.cwd()): ServiceInfo {
  const mgr = serviceManager();
  const base: ServiceInfo = {
    manager: mgr,
    label: mgr === 'launchd' ? getLaunchdLabel(projectRoot) : getSystemdUnit(projectRoot),
    state: 'not_installed',
    pid: null,
    project_root: projectRoot,
  };

  if (mgr === 'launchd') {
    const plistPath = launchdPlistPath(projectRoot);
    base.plist_path = plistPath;
    if (!fs.existsSync(plistPath)) return base;
    try {
      const output = execSync('launchctl list', { encoding: 'utf-8' });
      const line = output.split('\n').find((l) => l.includes(base.label));
      if (!line) {
        base.state = 'stopped';
        return base;
      }
      const pidField = line.trim().split(/\s+/)[0];
      if (pidField !== '-' && pidField) {
        base.state = 'running';
        base.pid = Number(pidField) || null;
      } else {
        base.state = 'stopped';
      }
    } catch {
      base.state = 'stopped';
    }
    return base;
  }

  if (mgr === 'systemd') {
    const unit = getSystemdUnit(projectRoot);
    base.unit = unit;
    const prefix = process.getuid?.() === 0 ? 'systemctl' : 'systemctl --user';
    try {
      execSync(`${prefix} is-active ${unit}`, { stdio: 'ignore' });
      base.state = 'running';
      try {
        const pidStr = execSync(`${prefix} show ${unit} -p MainPID --value`, {
          encoding: 'utf-8',
        }).trim();
        const pid = Number(pidStr);
        if (Number.isInteger(pid) && pid > 0) base.pid = pid;
      } catch {
        // ignore
      }
    } catch {
      try {
        execSync(`${prefix} status ${unit}`, { stdio: 'ignore' });
        base.state = 'stopped';
      } catch {
        // unit file may not exist
      }
    }
    return base;
  }

  return base;
}

export function installService(projectRoot: string = process.cwd()): { ok: boolean; message: string } {
  execSync('pnpm exec tsx setup/index.ts --step service', {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  const info = getServiceInfo(projectRoot);
  return {
    ok: info.state !== 'not_installed',
    message: info.state === 'not_installed' ? 'Service install finished but unit not found' : 'Service installed',
  };
}

export function startService(projectRoot: string = process.cwd()): ServiceInfo {
  const info = getServiceInfo(projectRoot);
  if (info.manager === 'none') {
    throw new Error('Service management is not supported on this platform');
  }
  if (info.state === 'not_installed') {
    throw new Error(`Service not installed. Run: luna service install`);
  }

  if (info.manager === 'launchd') {
    const plistPath = launchdPlistPath(projectRoot);
    ensureLaunchdUsesAppBundle(projectRoot, plistPath);
    if (info.state === 'stopped') {
      try {
        execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
      } catch {
        // May already be loaded but not running
      }
    }
    execSync(`launchctl kickstart ${guiDomain()}/${info.label}`, { stdio: 'inherit' });
  } else if (info.manager === 'systemd' && info.unit) {
    const prefix = process.getuid?.() === 0 ? 'systemctl' : 'systemctl --user';
    execSync(`${prefix} start ${info.unit}`, { stdio: 'inherit' });
  }

  return getServiceInfo(projectRoot);
}

export function stopService(projectRoot: string = process.cwd()): ServiceInfo {
  const info = getServiceInfo(projectRoot);
  if (info.manager === 'none') {
    throw new Error('Service management is not supported on this platform');
  }
  if (info.state === 'not_installed') {
    throw new Error(`Service not installed. Run: luna service install`);
  }

  if (info.manager === 'launchd' && info.plist_path) {
    execSync(`launchctl unload ${JSON.stringify(info.plist_path)}`, { stdio: 'inherit' });
  } else if (info.manager === 'systemd' && info.unit) {
    const prefix = process.getuid?.() === 0 ? 'systemctl' : 'systemctl --user';
    execSync(`${prefix} stop ${info.unit}`, { stdio: 'inherit' });
  }

  return getServiceInfo(projectRoot);
}

export function restartService(projectRoot: string = process.cwd()): ServiceInfo {
  const info = getServiceInfo(projectRoot);
  if (info.manager === 'none') {
    throw new Error('Service management is not supported on this platform');
  }
  if (info.state === 'not_installed') {
    throw new Error(`Service not installed. Run: luna service install`);
  }
  if (info.state === 'stopped') return startService(projectRoot);

  if (info.manager === 'launchd') {
    const plistPath = launchdPlistPath(projectRoot);
    ensureLaunchdUsesAppBundle(projectRoot, plistPath);
    execSync(`launchctl kickstart -k ${guiDomain()}/${info.label}`, { stdio: 'inherit' });
  } else if (info.manager === 'systemd' && info.unit) {
    const prefix = process.getuid?.() === 0 ? 'systemctl' : 'systemctl --user';
    execSync(`${prefix} restart ${info.unit}`, { stdio: 'inherit' });
  }

  return getServiceInfo(projectRoot);
}
