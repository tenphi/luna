/**
 * Telegram channel adapter — a thin wrapper over the Chat SDK bridge.
 *
 * There used to be a pairing interceptor wrapped around `onInbound`: it swallowed a 4-digit code, and
 * whoever sent it first became the install owner. Both halves are gone. Ownership is `owner` in
 * `config/local.jsonc`, and an inbound identity is matched against the configured Telegram handle by
 * `src/users/binding.ts` — so there is nothing to intercept, and no path by which sending a message
 * grants privilege.
 */
import { createTelegramAdapter, type TelegramAdapter } from '@chat-adapter/telegram';
import type { Attachment } from 'chat';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge, type ForwardContext, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import { normalizeTelegramMarkdown } from './telegram-markdown.js';
import { registerTelegramBotCommands } from './telegram-bot-commands.js';
import { enableTelegramSilentSends, isSilentContent, withSilentTelegramSends } from './telegram-silent.js';
import { createTelegramDraftSender, type TelegramDraftSender } from './telegram-draft.js';
import { createTelegramMemoryDeliver } from './telegram-memory-receipt.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Flatten Telegram Rich Markdown blocks into plain text for quote context.
 * Prefer `rich_message.markdown` when present (how Luna sends); fall back to
 * walking `blocks` when Telegram echoes the structured form.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRichMessageText(rich: any): string {
  if (!rich || typeof rich !== 'object') return '';
  if (typeof rich.markdown === 'string' && rich.markdown.trim()) return rich.markdown;
  if (!Array.isArray(rich.blocks)) return '';
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (node) parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string' || Array.isArray(obj.text)) walk(obj.text);
    if (typeof obj.expression === 'string' && obj.expression) parts.push(obj.expression);
    if (typeof obj.alternative_text === 'string' && obj.alternative_text) parts.push(obj.alternative_text);
    if (typeof obj.summary === 'string' && obj.summary) parts.push(obj.summary);
    if (Array.isArray(obj.blocks)) walk(obj.blocks);
    if (Array.isArray(obj.items)) walk(obj.items);
    if (obj.caption) walk(obj.caption);
    if (obj.credit) walk(obj.credit);
  };
  walk(rich.blocks);
  return parts.join('').trim();
}

/** Resolve quote text from a Telegram Message (plain, caption, or rich_message). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTelegramReplyText(reply: Record<string, any>): string {
  if (typeof reply.text === 'string' && reply.text) return reply.text;
  if (typeof reply.caption === 'string' && reply.caption) return reply.caption;
  return extractRichMessageText(reply.rich_message);
}

/**
 * Extract reply-to context from Telegram's raw Bot API message.
 * Exported for unit tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  const chatId = raw.chat?.id ?? reply.chat?.id;
  const messageId = reply.message_id;
  const id = chatId != null && messageId != null ? `${chatId}:${messageId}` : undefined;
  return {
    text: extractTelegramReplyText(reply),
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    ...(id ? { id } : {}),
  };
}

/**
 * The files of the message a Telegram reply quotes. Telegram embeds the quoted message whole in
 * `reply_to_message`, file ids included, so the adapter's own parser yields attachments that
 * download on demand — the same ones the quoted message produced when it arrived.
 *
 * Exported for unit tests.
 */
export function quotedTelegramAttachments(
  adapter: Pick<TelegramAdapter, 'parseMessage'>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>,
): Attachment[] {
  const quoted = raw.reply_to_message;
  if (!quoted || typeof quoted !== 'object' || !quoted.chat) return [];
  return adapter.parseMessage(quoted).attachments ?? [];
}

/**
 * Extract the forward origin from a Telegram raw message.
 *
 * `forward_origin` is the Bot API 7.0 shape; the flat `forward_from` /
 * `forward_sender_name` / `forward_date` fields are what older payloads (and
 * some clients) still carry, so both are read. A `hidden_user` origin gives a
 * name and no account, and a channel forward gives the channel — both are worth
 * surfacing, because either way the words are not the sender's own.
 *
 * Exported for unit tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractForwardContext(raw: Record<string, any>): ForwardContext | null {
  const origin = raw.forward_origin;
  const legacyDate = typeof raw.forward_date === 'number' ? raw.forward_date : undefined;
  const iso = (unix: unknown): string | undefined =>
    typeof unix === 'number' && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : undefined;
  const personName = (user: Record<string, any> | undefined): string | undefined => {
    if (!user) return undefined;
    const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    return full || user.username || undefined;
  };

  if (origin && typeof origin === 'object') {
    switch (origin.type) {
      case 'user':
        return { ...pick(personName(origin.sender_user)), ...pickDate(iso(origin.date)) };
      case 'hidden_user':
        return {
          ...pick(typeof origin.sender_user_name === 'string' ? origin.sender_user_name : undefined),
          ...pickDate(iso(origin.date)),
          hidden: true,
        };
      case 'chat':
        return { ...pick(origin.sender_chat?.title), ...pickDate(iso(origin.date)) };
      case 'channel':
        return { ...pick(origin.chat?.title ?? origin.author_signature), ...pickDate(iso(origin.date)) };
      default:
        // An origin type we don't model still means "not the sender's words".
        return { ...pickDate(iso(origin.date)) };
    }
  }

  if (raw.forward_from || raw.forward_sender_name || raw.forward_from_chat || legacyDate !== undefined) {
    const name =
      personName(raw.forward_from) ??
      (typeof raw.forward_sender_name === 'string' ? raw.forward_sender_name : undefined) ??
      raw.forward_from_chat?.title;
    return {
      ...pick(name),
      ...pickDate(iso(legacyDate)),
      ...(raw.forward_from ? {} : raw.forward_sender_name ? { hidden: true } : {}),
    };
  }

  return null;
}

/** Omit an absent name rather than writing `from: undefined` into the payload. */
function pick(name: unknown): { from?: string } {
  return typeof name === 'string' && name.trim() ? { from: name.trim() } : {};
}

function pickDate(iso: string | undefined): { date?: string } {
  return iso ? { date: iso } : {};
}

/**
 * Route each outbound blob to the mechanism it needs.
 *
 *   - `operation: 'stream'` → a **live draft**: the answer as it is written.
 *     Notifies nothing and is replaced by the real message. Not a message, so
 *     it returns no id.
 *   - `silent: true` → a real message with `disable_notification`: status
 *     bubbles and topic dividers land without a sound. Edits and deletes never
 *     notify, so only the initial send needs it.
 *   - `type: 'memory_change'` → a native HTML receipt with literal source text
 *     in preformatted diff snippets with section and line locations.
 *   - anything else → an ordinary message. The answer is what pings.
 *
 * Exported for tests; `fallback` is the bridge's own deliver.
 */
export function createQuietDeliver(
  drafts: TelegramDraftSender,
  fallback: ChannelAdapter['deliver'],
  memoryDeliver?: ChannelAdapter['deliver'],
): ChannelAdapter['deliver'] {
  return async function deliverQuietly(platformId, threadId, message) {
    const content = (message.content ?? {}) as Record<string, unknown>;

    if (content.operation === 'stream') {
      const streamId = Number(content.streamId);
      const ok =
        Number.isFinite(streamId) && (await drafts.send(platformId, threadId, streamId, String(content.text ?? '')));
      // Throwing is the contract for "this channel can't stream here" — a group
      // chat, or an API refusal. The caller stops previewing for the turn.
      if (!ok) throw new Error('Telegram live drafts unavailable for this chat');
      return;
    }

    if (content.type === 'memory_change' && memoryDeliver) {
      return memoryDeliver(platformId, threadId, message);
    }

    return isSilentContent(content)
      ? withSilentTelegramSends(() => fallback(platformId, threadId, message))
      : fallback(platformId, threadId, message);
  };
}

/** Look up the bot username via Telegram getMe. */
registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });

    enableTelegramSilentSends(telegramAdapter);

    // Keep Rich Messages enabled so Telegram can render GFM tables natively.
    // The adapter falls back to MarkdownV2 and remembers the capability failure
    // when Telegram rejects sendRichMessage for an unsupported client/API.
    // Normalize GFM first so lazy `1.` markers and unindented sub-bullets
    // become 1/2/3 on either delivery path.
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      extractForwardContext,
      extractQuotedAttachments: (raw) => quotedTelegramAttachments(telegramAdapter, raw),
      supportsThreads: false,
      transformOutboundText: normalizeTelegramMarkdown,
      // Split under Telegram's sendMessage cap (4096). Leave headroom for
      // MarkdownV2 escaping so chunks still fit after conversion.
      maxTextLength: 3500,
    });

    const wrapped: ChannelAdapter = {
      ...bridge,
      deliver: createQuietDeliver(createTelegramDraftSender(token), bridge.deliver, createTelegramMemoryDeliver(token)),
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        await registerTelegramBotCommands(token);
        return withRetry(() => bridge.setup(hostConfig), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
