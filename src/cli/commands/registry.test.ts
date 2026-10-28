import { describe, expect, it } from 'vitest';

/**
 * The command registry loads by side effect: `src/cli/commands/index.ts` is a list of
 * `import './thing.js';` lines, and each module registers itself on import.
 *
 * **TypeScript cannot see a broken one.** An import with bindings that names a deleted module is
 * `TS2307`; a side-effect-only import of a deleted module is *not an error at all* — verified
 * against this repo's own tsc. So removing a command file leaves an import that typechecks, lints,
 * and then crashes `luna` at startup with `ERR_MODULE_NOT_FOUND` before a single command runs. That
 * is exactly what happened when the old memory commands were deleted.
 *
 * Importing the registry here is the cheapest thing that would have caught it: if any module in the
 * list is missing, this fails.
 */
describe('the CLI command registry', () => {
  it('imports without a missing module', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });

  it('registers the commands the admin surface is built from', async () => {
    await import('./index.js');
    const { listCommands } = await import('../registry.js');
    const names = listCommands().map((command) => command.name);

    // A spread across the groups rather than an exhaustive list, which would turn every new
    // command into a failing test. These are the ones other things depend on existing.
    for (const expected of ['health', 'restart', 'config', 'config-memory', 'config-memory-set']) {
      expect(names).toContain(expected);
    }
  });

  it('has no command left over from the memory backend that was removed', async () => {
    // These three went out with GBrain. A command that still registers is a command an admin can
    // still run, against a database that is not there any more — and the failure it produces says
    // nothing about why. Named explicitly rather than pattern-matched: `config-memory` is current
    // and would be caught by anything matching on "memory".
    await import('./index.js');
    const { listCommands } = await import('../registry.js');
    const names = listCommands().map((command) => command.name);

    for (const gone of ['gbrain-reindex', 'gbrain-reset', 'config-migrate']) {
      expect(names).not.toContain(gone);
    }
    expect(names.filter((name) => name.startsWith('gbrain'))).toEqual([]);
  });
});
