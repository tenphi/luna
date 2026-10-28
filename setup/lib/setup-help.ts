/**
 * Setup "stuck" helpers for long interactive flows (e.g. Teams).
 * Prints context the operator can paste into an editor agent or docs —
 * no external CLI handoff.
 */
import k from 'kleur';

import * as setupLog from '../logs.js';
import { note } from './theme.js';

export interface HandoffContext {
  channel: string;
  step: string;
  stepDescription: string;
  completedSteps: string[];
  collectedValues: Record<string, string>;
  files?: string[];
}

const HELP_ESCAPE = '?';

export function isHelpEscape(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === HELP_ESCAPE;
}

/** Lets the operator type `?` at a text/password prompt to request help. */
export function validateWithHelpEscape(
  validate: (value: string | undefined) => string | undefined,
): (value: string | undefined) => string | undefined {
  return (value) => {
    if (isHelpEscape(value)) return undefined;
    return validate(value);
  };
}

export async function offerSetupHelp(ctx: HandoffContext): Promise<void> {
  const lines: string[] = [`Channel: ${ctx.channel}`, `Step: ${ctx.step}`, `Working on: ${ctx.stepDescription}`, ''];

  if (ctx.completedSteps.length > 0) {
    lines.push('Completed so far:');
    for (const s of ctx.completedSteps) lines.push(`  • ${s}`);
    lines.push('');
  }

  const entries = Object.entries(ctx.collectedValues);
  if (entries.length > 0) {
    lines.push('Values collected (secrets redacted):');
    for (const [key, val] of entries) lines.push(`  ${key}: ${val}`);
    lines.push('');
  }

  if (ctx.files?.length) {
    lines.push('Relevant files:');
    for (const f of ctx.files) lines.push(`  • ${f}`);
    lines.push('');
  }

  lines.push(
    k.dim('Copy the block above into your editor agent, or read the files listed.'),
    k.dim('When ready, return here and continue setup (or re-run `luna setup`).'),
  );

  setupLog.userInput('setup_help', `${ctx.channel}:${ctx.step}`);
  note(lines.join('\n'), 'Need help?');
}
