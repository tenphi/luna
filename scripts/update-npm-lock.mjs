#!/usr/bin/env node
// npm consumers do not honor pnpm overrides. Ship a production shrinkwrap so
// the exact audited transitive graph travels with the package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const metadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
// npm ignores pnpm's minimumReleaseAge, so resolve only versions that were
// already published that long ago. Exclusions are pnpm-only; an excluded
// package newer than the gate has to wait for it here.
const gate = fs.readFileSync('pnpm-workspace.yaml', 'utf8').match(/^minimumReleaseAge:\s*(\d+)\s*$/m);
if (!gate) throw new Error('pnpm-workspace.yaml must set minimumReleaseAge.');
const before = new Date(Date.now() - Number(gate[1]) * 60_000).toISOString();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-npm-lock-'));
try {
  const manifest = Object.fromEntries(
    ['name', 'version', 'license', 'type', 'engines', 'os', 'dependencies', 'overrides'].map((key) => [
      key,
      metadata[key],
    ]),
  );
  fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify(manifest, null, 2));
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      `--before=${before}`,
    ],
    { cwd: temporary, stdio: 'inherit' },
  );
  fs.copyFileSync(path.join(temporary, 'package-lock.json'), 'npm-shrinkwrap.json');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
