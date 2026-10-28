/**
 * Outbound message operations (container side).
 *
 * Thin async wrappers over the SessionClient. The host allocates the single
 * monotonic seq server-side and persists the row into `session.db`.
 */
import { getSessionClient, type RoutingBySeq, type WriteMessageOut } from '../session/client.js';

export type { WriteMessageOut };

/**
 * Write a new outbound message. The host allocates one monotonic seq shared
 * across inbound + outbound (so seq is a stable, unambiguous agent-facing
 * message id for edit_message) and returns it.
 */
export function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  return getSessionClient().writeMessageOut(msg);
}

/**
 * Look up a message's platform ID by seq number. For inbound rows the id is
 * already the platform message id; for outbound rows the host resolves the
 * platform id from the delivered table (falling back to the internal id).
 */
export function getMessageIdBySeq(seq: number): Promise<string | null> {
  return getSessionClient().getMessageIdBySeq(seq);
}

/** Look up routing fields (channel/platform/thread) for a message by seq. */
export function getRoutingBySeq(seq: number): Promise<RoutingBySeq | null> {
  return getSessionClient().getRoutingBySeq(seq);
}
