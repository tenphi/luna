/**
 * Unified setup — runs the standard install steps in order.
 *
 * Usage: pnpm exec tsx setup/index.ts --apply
 */
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const APPLY_STEPS = ['environment', 'container', 'onecli', 'auth', 'mounts', 'service', 'verify'] as const;

export async function run(_args: string[]): Promise<void> {
  for (const step of APPLY_STEPS) {
    log.info('Setup apply: running step', { step });
    emitStatus('APPLY', { STEP: step, STATUS: 'running' });
    const mod = await import(`./${step}.js`);
    await mod.run([]);
    emitStatus('APPLY', { STEP: step, STATUS: 'success' });
  }
  log.info('Setup apply complete');
  emitStatus('APPLY', { STATUS: 'success' });
}
