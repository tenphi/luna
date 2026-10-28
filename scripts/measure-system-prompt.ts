/**
 * CLI entry for system-prompt measurement (see src/lib/system-prompt-stats.ts).
 *
 *   luna system-prompt-stats [--session] [--tokens] [--json]
 *   pnpm exec tsx scripts/measure-system-prompt.ts
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { parseMeasureArgs, runSystemPromptStats } from '../src/lib/system-prompt-stats.js';

async function main(): Promise<void> {
  const opts = parseMeasureArgs(process.argv.slice(2));

  try {
    const out = await runSystemPromptStats(opts);
    if (typeof out === 'string') {
      console.log(out);
    } else {
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  void main();
}
