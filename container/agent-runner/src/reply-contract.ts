/**
 * The one thing every finished turn owes the user: a real message.
 *
 * Two producers have to agree on when that debt is paid, and they run in
 * different processes — the `luna` MCP server is a stdio child, the agent runner
 * is the parent — so the marker they agree on lives here instead of in either.
 *
 * The failure this exists to prevent: `send_message` aimed at the *current*
 * conversation is displayed as a live progress note rather than written to
 * `messages_out` (see `mcp-tools/core.ts`), and the collapsed progress bubble
 * keeps only tool lines (`src/progress/render.ts`). So a note is erased the
 * moment the turn ends. A model that answers only through that tool used to
 * finish on "✅ Done in Ns" with the answer gone and nothing in the database —
 * which also made the turn invisible to anyone reading the outbound table
 * afterwards.
 */

/**
 * Marker the `send_message` handler puts in its tool result when the send was
 * shown as a live note instead of being written to `messages_out`. A turn whose
 * only user-facing output carried this marker has delivered nothing.
 *
 * Bracketed and namespaced so it cannot collide with a destination name or with
 * prose the model might echo back.
 */
export const PROCESS_UPDATE_MARKER = '[luna:process-update]';

/** True when a send tool reported a live note that leaves no message behind. */
export function isProcessUpdateResult(result: string): boolean {
  return result.includes(PROCESS_UPDATE_MARKER);
}

/**
 * Last resort so a finished turn is never a silent "done". Used only when the
 * agent produced no other user-facing output — both when the model itself went
 * empty and when everything it wrote was internal scratchpad.
 */
export const EMPTY_ANSWER_FALLBACK =
  "Sorry — I finished working on that but couldn't compose a reply. Could you ask again?";
