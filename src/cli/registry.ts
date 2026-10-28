/**
 * Command registry — single source of truth for what `luna` can do.
 *
 * Each command file under `commands/` calls `register()` at top level,
 * and `commands/index.ts` imports them all for side effects so the
 * registry is populated before the host's CLI server accepts connections.
 */
import type { CallerContext } from './frame.js';

export type Access = 'open' | 'approval' | 'hidden';

export type CommandDef<TArgs = unknown, TData = unknown> = {
  name: string;
  description: string;
  access: Access;
  /** Resource this command belongs to (for help grouping). */
  resource?: string;
  /**
   * Set on the auto-generated `list` / `get` handlers (see `registerResource`).
   * These return raw DB rows that carry the resource's `scopeField`, so the
   * dispatcher applies post-handler group-scope filtering to their output.
   * Custom operations return ad-hoc shapes and leave this undefined.
   */
  generic?: 'list' | 'get';
  /** Validates `frame.args` and produces the typed handler input. Throws on invalid. */
  parseArgs: (raw: Record<string, unknown>) => TArgs;
  /**
   * Cheap allowlist checks on raw args, run BEFORE the approval gate. Throws
   * on invalid.
   *
   * `parseArgs` is too late for anything security-relevant: the dispatcher
   * short-circuits into `requestApproval` and returns, so `parseArgs` never
   * runs for an agent-initiated approval command until *after* the owner has
   * already tapped. Use this hook for checks that must keep a malformed
   * request off the approval card in the first place.
   */
  validateArgs?: (raw: Record<string, unknown>) => void;
  /** Overrides the approval card's title/question when the generic arg summary is too thin. */
  approvalCard?: (raw: Record<string, unknown>, ctx: CallerContext) => { title?: string; question?: string };
  handler: (args: TArgs, ctx: CallerContext) => Promise<TData>;
};

const registry = new Map<string, CommandDef>();

export function register<TArgs, TData>(def: CommandDef<TArgs, TData>): void {
  if (registry.has(def.name)) {
    throw new Error(`CLI command "${def.name}" already registered`);
  }
  registry.set(def.name, def as CommandDef);
}

export function lookup(name: string): CommandDef | undefined {
  return registry.get(name);
}

export function listCommands(): CommandDef[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}
