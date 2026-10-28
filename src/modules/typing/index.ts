import { hasProgressSession } from '../../progress/controller.js';
import { getLiveness } from '../../session-liveness.js';

type TypingAdapter = { setTyping?(channel: string, platform: string, thread: string | null): Promise<void> };
type Target = { channel: string; platform: string; thread: string | null; graceUntil: number; pauseUntil: number };
let transport: TypingAdapter | undefined;
let ticker: NodeJS.Timeout | undefined;
const targets = new Map<string, Target>();

function send(target: Target): void {
  try {
    void transport?.setTyping?.(target.channel, target.platform, target.thread).catch(() => {});
  } catch {
    /* Typing never blocks a reply. */
  }
}
function working(session: string): boolean {
  const state = getLiveness(session);
  return Boolean(
    state?.tool || (state?.lastSeenMs && Date.now() - state.lastSeenMs < 6000 && hasProgressSession(session)),
  );
}
function refresh(): void {
  const now = Date.now();
  for (const [session, target] of targets) {
    if (target.pauseUntil > now) continue;
    if (target.graceUntil > now || working(session)) send(target);
    else stopTypingRefresh(session);
  }
}
export function setTypingAdapter(adapter: TypingAdapter): void {
  transport = adapter;
}
export function startTypingRefresh(
  sessionId: string,
  _agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  const target = {
    channel: channelType,
    platform: platformId,
    thread: threadId,
    graceUntil: Date.now() + 15000,
    pauseUntil: 0,
  };
  targets.set(sessionId, target);
  send(target);
  if (!ticker) {
    ticker = setInterval(refresh, 4000);
    ticker.unref();
  }
}
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const target = targets.get(sessionId);
  if (target) target.pauseUntil = Date.now() + 1500;
}
export function stopTypingRefresh(sessionId: string): void {
  targets.delete(sessionId);
  if (!targets.size && ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}
