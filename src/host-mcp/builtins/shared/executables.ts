import { execSync } from 'child_process';
import fs from 'fs';

const CLI_SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/** Resolve CLI to an absolute path (launchd often omits Homebrew from PATH). */
export function resolveCliPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const dirs = [...pathEnv.split(':').filter(Boolean), ...CLI_SEARCH_DIRS];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const full = `${dir.replace(/\/$/, '')}/${name}`;
    try {
      if (fs.existsSync(full)) return full;
    } catch {
      /* ignore */
    }
  }
  try {
    return (
      execSync(`command -v ${name}`, { encoding: 'utf-8', env: { ...process.env, PATH: dirs.join(':') } }).trim() ||
      null
    );
  } catch {
    return null;
  }
}
