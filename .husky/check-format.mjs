import { execFileSync, spawnSync } from 'node:child_process';

const changed = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'], {
  encoding: 'utf8',
}).split('\0').filter((name) => name.startsWith('src/') && name.endsWith('.ts'));
if (changed.length) {
  const checked = spawnSync('pnpm', ['exec', 'prettier', '--check', ...changed], { stdio: 'inherit' });
  if (checked.error) console.error(checked.error.message);
  process.exit(checked.status ?? 1);
}
