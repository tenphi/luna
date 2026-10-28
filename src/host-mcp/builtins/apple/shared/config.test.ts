import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', () => ({
  readEnvFile: () => ({}),
}));

import { clearConfigCache } from '../../../../config/loader.js';
import { DEFAULT_APPLE_CONFIG, loadAppleConfig, saveAppleConfig } from './config.js';

describe('apple config', () => {
  const origCwd = process.cwd();
  let tmpDir: string;

  afterEach(() => {
    process.chdir(origCwd);
    clearConfigCache();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults calendar to Home and reminders list to Reminders from unified config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-apple-'));
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(origCwd, 'config', 'default.jsonc'), path.join(tmpDir, 'config', 'default.jsonc'));
    clearConfigCache();
    const cfg = loadAppleConfig();
    expect(cfg.apps.calendar.defaultCalendar).toBe('Home');
    expect(cfg.apps.reminders.defaultList).toBe('Reminders');
  });

  it('loads and saves calendar override via local.jsonc', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-apple-'));
    process.chdir(tmpDir);
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true });
    fs.copyFileSync(path.join(origCwd, 'config', 'default.jsonc'), path.join(tmpDir, 'config', 'default.jsonc'));
    const cfg = {
      ...DEFAULT_APPLE_CONFIG,
      apps: {
        ...DEFAULT_APPLE_CONFIG.apps,
        calendar: { enabled: true, defaultCalendar: 'Household' },
      },
    };
    saveAppleConfig(cfg);
    clearConfigCache();
    const loaded = loadAppleConfig();
    expect(loaded.apps.calendar.defaultCalendar).toBe('Household');
    const local = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'local.jsonc'), 'utf-8')) as {
      apple: { apps: { calendar: { defaultCalendar: string } } };
    };
    expect(local.apple.apps.calendar.defaultCalendar).toBe('Household');
  });
});
