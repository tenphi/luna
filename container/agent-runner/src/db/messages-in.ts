/**
 * Inbound message operations (container side).
 *
 * Thin async wrappers over the SessionClient. The host owns message lifecycle:
 * markProcessing/markCompleted update `messages_in.status` directly on the host
 * (there is no more processing_ack side-channel).
 */
import { getSessionClient, type MessageInRow } from '../session/client.js';

export type { MessageInRow };

/**
 * Fetch pending messages due for processing, oldest-first. The host applies
 * the on_wake / process_after / limit filtering and returns the batch the
 * agent should see.
 */
export function getPendingMessages(isFirstPoll = false): Promise<MessageInRow[]> {
  return getSessionClient().getPendingMessages(isFirstPoll);
}

/** Mark messages as processing (host sets messages_in.status = 'processing'). */
export function markProcessing(ids: string[]): Promise<void> {
  return getSessionClient().markProcessing(ids);
}

/** Mark messages as completed (host sets messages_in.status = 'completed'). */
export function markCompleted(ids: string[]): Promise<void> {
  return getSessionClient().markCompleted(ids);
}
