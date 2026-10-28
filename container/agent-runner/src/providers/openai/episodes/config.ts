/**
 * Episode settings, resolved from the agent's `context.topics` block with the
 * product defaults applied.
 */
import type { TopicsConfig } from '../context.js';
import { DEFAULT_CONTINUE_WINDOW_MINUTES } from './decide.js';

export type ResolvedTopicsConfig = Required<TopicsConfig>;

/** Episodes listed in `<recent-conversations>` — each costs ~60-100 tokens per turn. */
const DEFAULT_INJECT_COUNT = 4;

export function resolveTopicsConfig(raw?: TopicsConfig | null): ResolvedTopicsConfig {
  return {
    enabled: raw?.enabled ?? true,
    classifier: raw?.classifier ?? 'decisions',
    continueWindowMinutes: raw?.continueWindowMinutes ?? DEFAULT_CONTINUE_WINDOW_MINUTES,
    injectCount: raw?.injectCount ?? DEFAULT_INJECT_COUNT,
    mirrorToMemory: raw?.mirrorToMemory ?? true,
    summaryModel: raw?.summaryModel ?? 'memory',
  };
}
