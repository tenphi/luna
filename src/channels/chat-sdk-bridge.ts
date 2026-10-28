import { randomUUID } from 'node:crypto';
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  type Adapter,
  type Attachment,
  type ConcurrencyStrategy,
  type Message,
} from 'chat';
import { getAskQuestionRender } from '../db/sessions.js';
import { log } from '../log.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { normalizeOptions } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

export type ReplyContext = { sender: string; text: string; id?: string };
export type ForwardContext = { hidden?: boolean; date?: string; from?: string };
// Raw platform payloads are decoded by the platform-specific extractor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ForwardContextExtractor = (raw: Record<string, any>) => ForwardContext | null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QuotedAttachmentExtractor = (raw: Record<string, any>) => Attachment[];
export type ChatSdkBridgeConfig = {
  adapter: Adapter;
  supportsThreads: boolean;
  concurrency?: ConcurrencyStrategy;
  extractReplyContext?: ReplyContextExtractor;
  extractForwardContext?: ForwardContextExtractor;
  /** Files carried by the message being replied to, which the reply's own payload does not include. */
  extractQuotedAttachments?: QuotedAttachmentExtractor;
  transformOutboundText?: (text: string) => string;
  maxTextLength?: number;
};

/** Bound each post while preserving a useful paragraph, line, or word boundary. */
export function splitForLimit(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Message length must be a positive integer');
  if (text.length <= limit) return [text];
  const result: string[] = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + limit, text.length);
    if (end < text.length) {
      const window = text.slice(position, end + 1);
      const boundary = ['\n\n', '\n', ' '].map((separator) => window.lastIndexOf(separator)).find((index) => index > 0);
      if (boundary !== undefined) end = position + boundary;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      if (end === position) throw new RangeError('Message limit cannot hold a Unicode character');
    }
    const chunk = text.slice(position, end).trimEnd();
    if (chunk) result.push(chunk);
    position = end;
    while (position < text.length && /\s/.test(text[position])) position++;
  }
  return result;
}

type Transmission = { next: number; attachmentsDone: boolean; head?: string };
function outgoing(config: ChatSdkBridgeConfig): ChannelAdapter['deliver'] {
  const partial = new Map<string, Transmission>();
  const transform = (text: string) => config.transformOutboundText?.(text) ?? text;
  const adapter = config.adapter;
  return async (platform, thread, message: OutboundMessage) => {
    const address = thread ?? platform;
    const body = (message.content ?? {}) as Record<string, unknown>;
    const plain = body.plain === true || typeof body.raw === 'string';
    const text = String(body.raw ?? body.markdown ?? body.text ?? '');
    const postable = (value: string): { raw: string } | { markdown: string } =>
      plain ? { raw: value } : { markdown: value };
    if (body.operation === 'delete' && body.messageId) {
      await adapter.deleteMessage(address, String(body.messageId));
      return;
    }
    if (body.operation === 'edit' && body.messageId) {
      await adapter.editMessage(address, String(body.messageId), postable(plain ? text : transform(text)));
      return;
    }
    if (body.type === 'ask_question' && body.questionId && Array.isArray(body.options)) {
      if (typeof body.title !== 'string' || !body.title) {
        log.error('An interactive question requires a title');
        return;
      }
      const choices = normalizeOptions(body.options);
      const question = String(body.question ?? '');
      const card = Card({
        title: body.title,
        children: [
          CardText(question),
          Actions(
            choices.map((choice, index) =>
              Button({ id: `lq:${body.questionId}:${index}`, label: choice.label, value: String(index) }),
            ),
          ),
        ],
      });
      return (
        await adapter.postMessage(address, {
          card,
          fallbackText: `${body.title}\n\n${question}\nOptions: ${choices.map((choice) => choice.label).join(', ')}`,
        })
      )?.id;
    }
    const visible = plain || body.type === 'memory_change' ? text : transform(text);
    const files = message.files;
    if (!visible) {
      if (files?.length) return (await adapter.postMessage(address, { markdown: '', files }))?.id;
      return;
    }
    const parts = config.maxTextLength ? splitForLimit(visible, config.maxTextLength) : [visible];
    const key = message.id ? `${address}\0${message.id}` : undefined;
    const progress = (key && partial.get(key)) || { next: 0, attachmentsDone: false };
    if (key) {
      partial.delete(key);
      partial.set(key, progress);
      if (partial.size > 100) partial.delete(partial.keys().next().value!);
    }
    const separateFiles = Boolean(files?.length && parts[0].length > 800);
    if (separateFiles && !progress.attachmentsDone) {
      progress.head = (await adapter.postMessage(address, { ...postable(''), files }))?.id;
      progress.attachmentsDone = true;
    }
    while (progress.next < parts.length) {
      const attach = files?.length && !progress.attachmentsDone && progress.next === 0;
      const result = await adapter.postMessage(address, {
        ...postable(parts[progress.next]),
        ...(attach ? { files } : {}),
      });
      progress.head ??= result?.id;
      if (attach) progress.attachmentsDone = true;
      progress.next++;
    }
    if (key) partial.delete(key);
    return progress.head;
  };
}

async function serializeAttachment(attachment: Attachment): Promise<Record<string, unknown>> {
  const fields = attachment as unknown as Record<string, unknown>;
  const result = Object.fromEntries(
    ['type', 'name', 'mimeType', 'size', 'width', 'height'].map((key) => [key, fields[key]]),
  );
  try {
    if (attachment.fetchData) result.data = Buffer.from(await attachment.fetchData()).toString('base64');
  } catch (error) {
    log.warn('Could not retrieve an incoming attachment', { type: attachment.type, error });
  }
  return result;
}

/**
 * Files a reply points at. "Save this" or "what does it say?" sent as a reply to a document is about
 * that document, but the quote carries no text for it and the agent may never have received it —
 * so the file comes along, marked as quoted. A failure here costs the file, never the reply.
 */
function quotedAttachments(config: ChatSdkBridgeConfig, raw: unknown): Attachment[] {
  if (!config.extractQuotedAttachments || !raw || typeof raw !== 'object') return [];
  /* eslint-disable no-catch-all/no-catch-all -- an unreadable quote must not cost the reply itself */
  try {
    return config.extractQuotedAttachments(raw as Record<string, unknown>);
  } catch (error) {
    log.warn('Could not read the attachments of a quoted message', { error });
    return [];
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function context(config: ChatSdkBridgeConfig, content: Record<string, unknown>, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const reply = config.extractReplyContext?.(raw as Record<string, unknown>);
  const forward = config.extractForwardContext?.(raw as Record<string, unknown>);
  if (reply) content.replyTo = reply;
  if (forward) content.forwardedFrom = forward;
}

/** Serialize an incoming SDK message for the router, with files inlined and reply/forward context. */
export async function toInboundMessage(
  config: ChatSdkBridgeConfig,
  message: Message,
  mentioned: boolean,
  group: boolean,
): Promise<InboundMessage> {
  const serialized = { ...message.toJSON() } as Record<string, unknown>;
  delete serialized.raw;
  const quoted = quotedAttachments(config, message.raw);
  if (message.attachments?.length || quoted.length) {
    serialized.attachments = [
      ...(await Promise.all((message.attachments ?? []).map(serializeAttachment))),
      ...(await Promise.all(
        quoted.map(async (attachment) => ({ ...(await serializeAttachment(attachment)), quoted: true })),
      )),
    ];
  }
  context(config, serialized, message.raw);
  const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
  if (author)
    Object.assign(serialized, {
      senderId: author.userId,
      sender: author.fullName ?? author.userName,
      senderName: author.fullName ?? author.userName,
    });
  return {
    kind: 'chat-sdk',
    content: serialized,
    id: message.id,
    timestamp: message.metadata.dateSent.toISOString(),
    isMention: mentioned,
    isGroup: group,
  };
}

/** Chat SDK handles Telegram polling; Luna owns authorization and session routing. */
export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const adapter = config.adapter;
  let instance: Chat | undefined;
  let storage: SqliteStateAdapter | undefined;
  let connected = false;
  const result: ChannelAdapter = {
    name: adapter.name,
    channelType: adapter.name,
    supportsThreads: config.supportsThreads,
    deliver: outgoing(config),
    async setup(host: ChannelSetup) {
      if (connected) return;
      storage = new SqliteStateAdapter();
      const chat = new Chat({
        adapters: { [adapter.name]: adapter },
        state: storage,
        concurrency: config.concurrency ?? 'concurrent',
        userName: adapter.userName || 'Luna',
        logger: 'silent',
      });
      instance = chat;
      const forward = async (thread: { id: string }, message: Message, mention: boolean, group: boolean) => {
        await host.onInbound(
          adapter.channelIdFromThreadId(thread.id),
          thread.id,
          await toInboundMessage(config, message, mention, group),
        );
      };
      chat.onDirectMessage((thread, message) => forward(thread, message, true, false));
      chat.onNewMention((thread, message) => forward(thread, message, true, true));
      chat.onSubscribedMessage((thread, message) => forward(thread, message, message.isMention === true, true));
      chat.onNewMessage(/[\s\S]*/, (thread, message) => forward(thread, message, false, true));
      chat.onSlashCommand(async (event) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = (event.raw ?? {}) as Record<string, any>;
        const thread = event.channel.id;
        const id =
          raw.chat?.id != null && raw.message_id != null
            ? `${raw.chat.id}:${raw.message_id}`
            : `${thread}:slash-${randomUUID()}`;
        const author = event.user;
        const name = author.fullName ?? author.userName;
        const content: Record<string, unknown> = {
          _type: 'chat:Message',
          id,
          threadId: thread,
          text: raw.text || raw.caption || [event.command, event.text].filter(Boolean).join(' '),
          author: { userId: author.userId, userName: author.userName, fullName: author.fullName },
          senderId: author.userId,
          sender: name,
          senderName: name,
        };
        context(config, content, raw);
        await host.onInbound(adapter.channelIdFromThreadId(thread), thread, {
          kind: 'chat-sdk',
          id,
          content,
          isMention: true,
          isGroup: raw.chat?.type !== 'private',
          timestamp: raw.date ? new Date(Number(raw.date) * 1000).toISOString() : new Date().toISOString(),
        });
      });
      chat.onAction(async (event) => {
        // The earlier prefix is accepted only for cards already held in private install state.
        const parsed = /^(?:lq|ncq):([^:]+):(.+)$/.exec(event.actionId);
        if (!parsed) return;
        const question = parsed[1];
        const render = getAskQuestionRender(question);
        const candidate = event.value ?? parsed[2];
        const selected = /^\d+$/.test(candidate) ? (render?.options[Number(candidate)]?.value ?? candidate) : candidate;
        const label = render?.options.find((choice) => choice.value === selected)?.selectedLabel ?? selected;
        try {
          await adapter.editMessage(event.threadId, event.messageId, {
            markdown: `${render?.title ?? '❓ Question'}\n\n${label}`,
          });
        } catch (error) {
          log.warn('Could not update the answered question card', { error });
        }
        host.onAction(question, selected, event.user?.userId ?? '');
      });
      try {
        await chat.initialize();
        connected = true;
      } catch (error) {
        try {
          await chat.shutdown();
        } catch {
          /* Preserve the setup failure. */
        }
        throw error;
      }
    },
    async teardown() {
      connected = false;
      await instance?.shutdown();
      instance = undefined;
      storage = undefined;
    },
    isConnected: () => connected,
    async setTyping(platform, thread) {
      await adapter.startTyping(thread ?? platform);
    },
    async subscribe(_platform, thread) {
      if (!storage) throw new Error('Channel is not initialized');
      await storage.subscribe(thread);
    },
  };
  if (adapter.openDM) result.openDM = async (handle) => adapter.channelIdFromThreadId(await adapter.openDM!(handle));
  return result;
}
