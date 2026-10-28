/**
 * Safety-mode gating for the in-process Apple MCP servers.
 *
 * Ports the griches `--read-only` / `--confirm-destructive` semantics:
 * - `read-only`: destructive tools (`delete_*`, and Messages `send_message`)
 *   are never registered.
 * - `confirm-destructive`: destructive tools gain an optional `confirm` arg and
 *   return a confirmation prompt unless `confirm: true` is passed.
 * - `normal` (default): all tools, no confirm gate.
 */
import * as z from 'zod';

import type { AppleSafetyMode } from './types.js';

export function isReadOnly(mode: AppleSafetyMode | undefined): boolean {
  return mode === 'read-only';
}

export function isConfirmDestructive(mode: AppleSafetyMode | undefined): boolean {
  return mode === 'confirm-destructive';
}

/**
 * Optional `confirm` field on destructive tool schemas. Present on every
 * destructive tool that is registered (i.e. not read-only); only *enforced*
 * under `confirm-destructive` via {@link confirmGuard}.
 */
export const confirmArg = z
  .boolean()
  .optional()
  .describe('Set to true to confirm this destructive action (enforced under confirm-destructive mode)');

/**
 * Short-circuit result for a destructive tool when confirmation is required but
 * not yet given. Returns null when the action may proceed.
 */
export function confirmGuard(
  mode: AppleSafetyMode | undefined,
  confirm: boolean | undefined,
  message: string,
): { content: Array<{ type: 'text'; text: string }> } | null {
  if (isConfirmDestructive(mode) && !confirm) {
    return { content: [{ type: 'text', text: message }] };
  }
  return null;
}
