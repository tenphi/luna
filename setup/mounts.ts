import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMountAllowlistPath } from '../src/install-paths.js';
import { parseMountAllowlist } from '../src/modules/mount-security/index.js';
import { optionValue } from './lib/arguments.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const filename = getMountAllowlistPath();
  if (fs.existsSync(filename) && !args.includes('--force')) {
    emitStatus('CONFIGURE_MOUNTS', { PATH: filename, STATUS: 'skipped', LOG: 'logs/setup.log' }); return;
  }
  const input = args.includes('--empty') ? { allowedRoots: [], blockedPatterns: [] } : JSON.parse(optionValue(args, '--json') ?? fs.readFileSync(0, 'utf8'));
  const policy = parseMountAllowlist(input);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
  emitStatus('CONFIGURE_MOUNTS', { PATH: filename, ALLOWED_ROOTS: policy.allowedRoots.length, STATUS: 'success', LOG: 'logs/setup.log' });
}
