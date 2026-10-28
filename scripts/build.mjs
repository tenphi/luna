import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// tsc does not delete old output. A package must never inherit stale tests or maps.
fs.rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
