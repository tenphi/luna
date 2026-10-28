/**
 * Telegram **live drafts** — how a reply is shown while it is still being written.
 *
 * Underneath a live draft is a typing action (`sendMessageTextDraftAction` via
 * `messages.setTyping`), surfaced to bots as `sendMessageDraft`. The client
 * renders it as a normal message pinned to the bottom of the chat and fades in
 * newly added characters. Nothing notifies, and nothing is stored: the draft is
 * replaced the moment a real message lands in the chat, which is exactly the
 * handoff we want when the finished answer is delivered.
 *
 * **Only append-only text belongs here.** The fade-in animates character
 * *additions*; text that rewrites itself re-animates from the start and the
 * chat visibly jumps. A reply being generated only grows, so it fits. A status
 * bubble ("🤔 Thinking… 3s" → "🔧 Reading a file · 5s") rewrites every tick and
 * does not — that is why status stays on silent messages (see
 * `telegram-silent.ts`), and why this module is not used for it.
 *
 * Two more constraints shape the callers:
 *
 * - **Users only.** Drafts cannot be sent to groups, so `send` declines a
 *   non-user chat locally rather than spending an API call to be told no.
 * - **Rate limits** are 20 calls / 5s and 40 calls / 30s per peer. The provider
 *   emits accumulated copy every 300ms (~3.3/s), well past the sustained
 *   budget, so the caller must throttle — see `src/progress/reply-stream.ts`.
 *
 * @see https://core.telegram.org/api/bots/ai — live response streaming
 */
import { log } from '../log.js';

/**
 * Telegram chat ids are negative for groups, supergroups, and channels, and
 * positive for users. Drafts are user-only, so this settles availability
 * without a round trip.
 */
function isUserChat(chatId: string): boolean {
  return /^\d+$/.test(chatId);
}

/** `telegram:1000000003` → `1000000003`. */
function chatIdOf(platformId: string): string {
  return platformId.split(':').slice(1).join(':');
}

export interface TelegramDraftSender {
  /**
   * Post or replace the live draft identified by `draftId`.
   *
   * Reusing a `draftId` updates that draft in place; a fresh one starts a
   * second draft alongside it. Returns false when drafts are unavailable for
   * this chat or the call failed — the caller should stop streaming rather
   * than retry, and let the real message speak for itself.
   */
  send(platformId: string, threadId: string | null, draftId: number, text: string): Promise<boolean>;
  /** Clear a draft. A real message in the chat clears it too. */
  clear(platformId: string, threadId: string | null, draftId: number): Promise<void>;
}

/**
 * Bot API draft calls, spoken directly.
 *
 * `@chat-adapter/telegram` drives drafts only from `stream()`, which owns the
 * entire lifecycle of one streamed reply — it cannot be borrowed for text that
 * reaches the host as coalesced status events rather than as an AsyncIterable.
 */
export function createTelegramDraftSender(token: string): TelegramDraftSender {
  async function call(payload: Record<string, unknown>): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessageDraft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram sendMessageDraft failed: ${data.description ?? res.status}`);
    }
  }

  /**
   * Threads are stripped for Telegram (`supportsThreads: false`), so `threadId`
   * is normally the platform id itself; a real forum topic id rides along.
   */
  function payloadFor(platformId: string, threadId: string | null, draftId: number, text: string) {
    const topicId = threadId && threadId !== platformId ? Number(threadId) : undefined;
    return {
      chat_id: chatIdOf(platformId),
      ...(topicId !== undefined && Number.isFinite(topicId) ? { message_thread_id: topicId } : {}),
      draft_id: draftId,
      // No parse_mode on purpose. Mid-stream markdown is both unparseable
      // (`**bo` has no closing pair) and a rewrite once it completes, which
      // restarts the fade-in. Callers send plain text; the real message that
      // replaces the draft carries the formatting.
      text,
    };
  }

  return {
    async send(platformId, threadId, draftId, text) {
      const chatId = chatIdOf(platformId);
      if (!chatId || !isUserChat(chatId)) return false;
      try {
        await call(payloadFor(platformId, threadId, draftId, text));
        return true;
      } catch (err) {
        // A lost draft update costs the user a preview, never the answer.
        log.warn('Telegram draft send failed', { err });
        return false;
      }
    },

    async clear(platformId, threadId, draftId) {
      if (!chatIdOf(platformId)) return;
      try {
        // Bots may pass empty text to clear a draft.
        await call(payloadFor(platformId, threadId, draftId, ''));
      } catch (err) {
        // Drafts expire on their own, and the next real message clears them.
        log.warn('Telegram draft clear failed', { err });
      }
    },
  };
}
