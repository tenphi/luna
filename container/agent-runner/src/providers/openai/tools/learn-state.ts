/**
 * Session-state key for the `/learn` toggle.
 *
 * Written by the container `/learn` handler (session-commands.ts) and read by
 * the host at fact-extraction enqueue time (the host's fact-extraction enqueue, which
 * uses the same literal key — host and container share no modules). Value is
 * the string 'true' or 'false'; unset means "fall back to the install default".
 */
export const LEARN_STATE_KEY = 'learn_enabled';
