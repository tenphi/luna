/**
 * Silent Telegram sends — the Bot API equivalent of the client's
 * "Send Without Sound".
 *
 * Telegram exposes this to bots as `disable_notification: true` on every
 * message-creating method: the message still lands and still counts as unread,
 * it just arrives without a sound or a banner. It is a per-call payload field,
 * not an account setting, so it has to be threaded down to the API call.
 *
 * `@chat-adapter/telegram` has no option for it — `postMessage` takes a
 * postable, not Bot API parameters — so the flag is carried out of band and
 * applied at the adapter's single API choke point (`telegramFetch`). The
 * carrier is an AsyncLocalStorage rather than a module flag on purpose: the
 * Telegram bridge runs deliveries concurrently, and a plain boolean set around
 * an `await` would leak onto whatever else was in flight (see
 * `src/host-mcp/caller-context.ts` for the same pattern).
 */
import { AsyncLocalStorage } from 'async_hooks';

import { log } from '../log.js';

const silentSends = new AsyncLocalStorage<true>();

/**
 * Message-creating Bot API methods the adapter calls that accept
 * `disable_notification`. Deliberately not "anything starting with send":
 * `sendChatAction` and `sendMessageDraft` have no notification to suppress.
 */
const SILENCEABLE_METHODS = new Set([
  'sendMessage',
  'sendRichMessage',
  'sendPhoto',
  'sendDocument',
  'sendAudio',
  'sendVideo',
]);

/** Run `fn` with every Telegram send it performs marked notification-free. */
export function withSilentTelegramSends<T>(fn: () => Promise<T>): Promise<T> {
  return silentSends.run(true, fn);
}

/** Add `disable_notification` to a JSON or multipart Bot API payload. */
function silencePayload(payload: unknown): unknown {
  if (payload instanceof FormData) {
    payload.set('disable_notification', 'true');
    return payload;
  }
  if (payload && typeof payload === 'object') {
    return { ...(payload as Record<string, unknown>), disable_notification: true };
  }
  return payload;
}

/**
 * Wrap the adapter's `telegramFetch` so sends inside
 * `withSilentTelegramSends` go out with `disable_notification: true`.
 *
 * The wrapper is installed as an own property, shadowing the prototype method
 * the adapter calls internally as `this.telegramFetch(...)`.
 */
export function enableTelegramSilentSends(adapter: object): void {
  const original = Reflect.get(adapter, 'telegramFetch');
  if (typeof original !== 'function') {
    log.warn('Telegram adapter has no telegramFetch — silent sends unavailable');
    return;
  }
  Reflect.set(
    adapter,
    'telegramFetch',
    function (this: unknown, method: string, payload: unknown, request?: unknown): unknown {
      const silence = silentSends.getStore() === true && SILENCEABLE_METHODS.has(method);
      return (original as (m: string, p: unknown, r?: unknown) => unknown).call(
        this,
        method,
        silence ? silencePayload(payload) : payload,
        request,
      );
    },
  );
}

/** True when an outbound content blob asks for a notification-free delivery. */
export function isSilentContent(content: unknown): boolean {
  return !!content && typeof content === 'object' && (content as Record<string, unknown>).silent === true;
}
