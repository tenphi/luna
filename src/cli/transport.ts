/**
 * Client-side transport interface. The `luna` binary picks one of these and
 * calls sendFrame; the caller doesn't know whether bytes traveled over a
 * Unix socket (host) or through the session's outbound and inbound rows (container).
 */
import type { RequestFrame, ResponseFrame } from './frame.js';

export interface Transport {
  sendFrame(req: RequestFrame): Promise<ResponseFrame>;
}
