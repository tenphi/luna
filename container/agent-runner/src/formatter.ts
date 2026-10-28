import type { DestinationEntry } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { collectImageAttachments, isStagedImageAttachment, type ImageAttachment } from './image-attachments.js';
import { parseRunnerCommand } from './session-commands.js';
import { parseSlashCommand } from './slash-command.js';
import { TIMEZONE, formatLocalDateParts, formatLocalTime } from './timezone.js';
export type { ImageAttachment } from './image-attachments.js';
export type FormattedPrompt = { images: ImageAttachment[]; prompt: string };
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';
export type CommandInfo = { text: string; senderId: string | null; category: CommandCategory; command: string };
export type RoutingContext = {
  inReplyTo: string | null; platformId: string | null; channelType: string | null; threadId: string | null;
  senderIsPrivileged: boolean; episodesEnabled: boolean; hotMemorySlug: string | null;
};
export type ReplyEvidence = { text: string; sender?: string; id?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type Data = Record<string, any>;
function record(json: string): Data {
  try { const value = JSON.parse(json); return value && typeof value === 'object' && !Array.isArray(value) ? value : { text: json }; }
  catch { return { text: json }; }
}
const xml = (value: unknown): string => String(value ?? '').replace(/[&<>\"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
const attributes = (values: Array<[string, unknown]>): string => values.filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => ` ${key}="${xml(value)}"`).join('');
const element = (name: string, values: Array<[string, unknown]>, body: string): string => `<${name}${attributes(values)}>${body}</${name}>`;
const chat = (row: MessageInRow): boolean => row.kind === 'chat' || row.kind === 'chat-sdk';
let origin: (channel: string | null, platform: string | null) => DestinationEntry | undefined = () => undefined;
export function setOriginResolver(resolve: typeof origin): void { origin = resolve; }
function source(row: MessageInRow): Array<[string, unknown]> {
  const known = origin(row.channel_type, row.platform_id);
  const name = known?.name ?? (row.channel_type || row.platform_id ? `unknown:${row.channel_type || ''}:${row.platform_id || ''}` : undefined);
  return name === undefined ? [] : [['from', name]];
}

export function categorizeMessage(row: MessageInRow): CommandInfo {
  const input = record(row.content);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const author = input.senderId || input.author?.userId;
  const senderId = typeof author !== 'string' ? null : author.includes(':') || !row.channel_type ? author : `${row.channel_type}:${author}`;
  const command = text.startsWith('/') ? parseSlashCommand(text) ?? '' : '';
  let category: CommandCategory = command ? 'passthrough' : 'none';
  if (command === '/remote-control') category = 'admin';
  if (['/help', '/login', '/logout', '/doctor', '/config', '/start'].includes(command)) category = 'filtered';
  return { senderId, category, command, text };
}
export const isRunnerCommand = (row: MessageInRow): boolean => parseRunnerCommand(row) !== null;
export function extractRouting(rows: MessageInRow[]): RoutingContext {
  const first = rows[0];
  const policy = first ? record(first.content)._luna : undefined;
  return {
    inReplyTo: first?.id ?? null, platformId: first?.platform_id ?? null, channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null, senderIsPrivileged: policy?.senderIsPrivileged === true,
    episodesEnabled: policy?.episodesEnabled === true,
    hotMemorySlug: typeof policy?.hotMemorySlug === 'string' && policy.hotMemorySlug.trim() ? policy.hotMemorySlug.trim() : null,
  };
}

function attachments(input: unknown): string {
  if (!Array.isArray(input) || !input.length) return '';
  return '\n' + input.map((attachment: Data) => {
    // A file from the message being replied to, not one sent with this message.
    const name = xml(attachment.name || attachment.filename || 'attachment') + (attachment.quoted === true ? ' (from the quoted message)' : '');
    const local = attachment.localPath ? `/workspace/${xml(attachment.localPath)}` : '';
    if (isStagedImageAttachment(attachment)) return local
      ? `[image: ${name} — shown above; original at ${local} (use memory_ingest only to keep the original file; for complete reference text, read each image and use memory_retain with ordered parts; do not Read the binary)]`
      : `[image: ${name} — shown above]`;
    if (typeof attachment.transcriptError === 'string' && attachment.transcriptError.trim()) {
      const unavailable = `voice message: could not be transcribed (${xml(attachment.transcriptError)})`;
      return `[${unavailable}${local ? `; audio at ${local}` : ''}]`;
    }
    const label = `${xml(attachment.type || 'file')}: ${name}`;
    return `[${label}${local ? ` — saved to ${local}` : attachment.url ? ` (${xml(attachment.url)})` : ''}]`;
  }).join('\n');
}

function render(row: MessageInRow): string {
  const input = record(row.content);
  const from = source(row);
  if (chat(row)) {
    const quote = input.replyTo;
    const forwarded = input.forwardedFrom && typeof input.forwardedFrom === 'object' ? input.forwardedFrom : undefined;
    const details: Array<[string, unknown]> = [
      ['id', row.seq], ...from, ['sender', input.sender || input.author?.fullName || input.author?.userName || 'Unknown'],
      ['time', formatLocalTime(row.timestamp, TIMEZONE)], ['reply_to', quote?.id ? String(quote.id) : undefined],
    ];
    if (forwarded) {
      details.push(['forwarded', 'true']);
      if (typeof forwarded.from === 'string' && forwarded.from.trim()) details.push(['forwarded_from', forwarded.from.trim()]);
      if (typeof forwarded.date === 'string' && forwarded.date) details.push(['forwarded_at', formatLocalTime(forwarded.date, TIMEZONE)]);
    }
    const preview = quote?.sender && quote?.text ? `\n  ${element('quoted_message', [['from', quote.sender]], xml(quote.text))}\n` : '';
    return element('message', details, preview + xml(input.text || '') + attachments(input.attachments));
  }
  if (row.kind === 'task') {
    const instructions = [
      'Execute this existing scheduled run. Do not create another copy of this schedule.', '',
      ...(input.scriptOutput ? ['Script output:', JSON.stringify(input.scriptOutput, null, 2), ''] : []),
      'Instructions:', input.prompt || '',
    ];
    return element('task', [...from, ['series_id', row.series_id ?? row.id], ['run_id', row.id], ['scheduled_for', formatLocalTime(row.process_after ?? row.timestamp, TIMEZONE)]], instructions.join('\n'));
  }
  if (row.kind === 'webhook') return element('webhook', [...from, ['source', input.source || 'unknown'], ['event', input.event || 'unknown']], JSON.stringify(input.payload || input, null, 2));
  return element('system_response', [...from, ['action', input.action || 'unknown'], ['status', input.status || 'unknown']], JSON.stringify(input.result || null));
}

export function formatMessages(messages: MessageInRow[], now = new Date()): string {
  const today = formatLocalDateParts(now, TIMEZONE);
  const header = `<context${attributes([['timezone', TIMEZONE], ['date', today.date], ['weekday', today.weekday]])} />\n`;
  const parts: string[] = [];
  const conversation = messages.filter(chat);
  if (conversation.length) parts.push(conversation.map(render).join('\n'));
  for (const kind of ['task', 'webhook', 'system']) parts.push(...messages.filter((row) => row.kind === kind).map(render));
  return header + parts.join('\n\n');
}
export const formatMessagesWithMedia = (messages: MessageInRow[], now?: Date): FormattedPrompt => ({ images: collectImageAttachments(messages), prompt: formatMessages(messages, now) });
export const stripInternalTags = (text: string): string => text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
export function extractUserText(messages: MessageInRow[]): string {
  const texts: string[] = [];
  for (const message of messages.filter(chat)) {
    const text = record(message.content).text;
    if (typeof text === 'string' && text.trim()) texts.push(text.trim());
  }
  return texts.join('\n');
}
export function extractReplyEvidence(messages: MessageInRow[]): ReplyEvidence | undefined {
  for (const message of messages.filter(chat).reverse()) {
    const quote = record(message.content).replyTo;
    if (!quote || typeof quote !== 'object') continue;
    const text = typeof quote.text === 'string' ? quote.text.trim() : '';
    const id = typeof quote.id === 'string' || typeof quote.id === 'number' ? String(quote.id) : '';
    if (text || id) return { text, ...(id ? { id } : {}), ...(typeof quote.sender === 'string' && quote.sender ? { sender: quote.sender } : {}) };
  }
  return undefined;
}
