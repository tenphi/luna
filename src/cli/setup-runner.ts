/**
 * Run setup subcommands with inherited stdio (interactive wizard / build output).
 * Invoked from `src/cli/client.ts` before the normal dispatch path.
 */
import { spawnSync } from 'child_process';

/** Mirrors `setup/index.ts` STEPS — keep in sync when adding steps. */
export const SETUP_STEP_NAMES = [
  'timezone',
  'set-env',
  'environment',
  'container',
  'register',
  'users',
  'bind-telegram',
  'telegram',
  'mounts',
  'service',
  'verify',
  'onecli',
  'auth',
  'cli-agent',
  'apple',
  'email',
  'tavily',
] as const;

export function printSetupHelp(): void {
  process.stdout.write(
    [
      'Luna setup',
      '',
      '  luna setup                 Interactive first-time setup (wizard)',
      '  luna setup apply           Run standard install steps non-interactively',
      '  luna setup step <name>     Run one setup step',
      '  luna setup help            Show this help',
      '',
      'Pass wizard flags after `setup`, e.g. luna setup --skip service',
      '',
      'Apply steps (in order): environment → container → onecli → auth → mounts → service → verify',
      '',
      'Available step names:',
      `  ${SETUP_STEP_NAMES.join(', ')}`,
      '',
      'Equivalent: pnpm run setup:auto  |  pnpm exec tsx setup/index.ts --apply',
      '',
    ].join('\n'),
  );
}

/**
 * @param rest argv after the `setup` token (e.g. `['apply']` or `['--skip', 'service']`)
 */
export function runSetupPassthrough(rest: string[], projectRoot: string = process.cwd()): number {
  const sub = rest[0];

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    printSetupHelp();
    return 0;
  }

  if (sub === 'apply') {
    return runPnpmTsx(['setup/index.ts', '--apply', ...rest.slice(1)], projectRoot);
  }

  if (sub === 'step') {
    const step = rest[1];
    if (!step) {
      process.stderr.write('luna setup: missing step name (luna setup step <name>)\n');
      printSetupHelp();
      return 2;
    }
    return runPnpmTsx(['setup/index.ts', '--step', step, ...rest.slice(2)], projectRoot);
  }

  if (sub === 'run') {
    return runPnpmTsx(['setup/auto.ts', ...rest.slice(1)], projectRoot);
  }

  // Default: interactive wizard. Bare `luna setup` or `luna setup --flags…`
  if (!sub || sub.startsWith('-')) {
    return runPnpmTsx(['setup/auto.ts', ...rest], projectRoot);
  }

  process.stderr.write(`luna setup: unknown subcommand "${sub}"\n\n`);
  printSetupHelp();
  return 2;
}

function runPnpmTsx(scriptArgs: string[], projectRoot: string): number {
  const result = spawnSync('pnpm', ['exec', 'tsx', ...scriptArgs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(
      `luna setup: failed to run: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}
