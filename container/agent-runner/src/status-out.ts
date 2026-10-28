/**
 * Emit an ephemeral progress hint for the host-side ProgressController.
 *
 * These do not go through `messages_out`. They are never retried and are
 * worthless once stale, so persisting them only bought a `seq`, a row, and a
 * `delivered` row per progress tick — which on a long-lived session was ~94% of
 * the outbound table. `writeStatus` applies them to the live status card and
 * stores nothing.
 */
import { getCurrentInReplyTo } from './current-batch.js';
import { getSessionClient } from './session/client.js';

export function writeStatusMessage(opts: {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  in_reply_to?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  return getSessionClient().writeStatus({
    channelType: opts.channel_type,
    platformId: opts.platform_id,
    threadId: opts.thread_id,
    inReplyTo: opts.in_reply_to ?? getCurrentInReplyTo(),
    payload: opts.payload,
  });
}
