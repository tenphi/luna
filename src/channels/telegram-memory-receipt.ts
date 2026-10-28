import { parseMarkdown } from 'chat';

import type { ChannelAdapter } from './adapter.js';
import { isSilentContent } from './telegram-silent.js';

interface ReceiptNode {
  type: string;
  value?: string;
  children?: ReceiptNode[];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Receipts use fenced diff snippets. Send them as native preformatted blocks
 * so source Markdown, hashtags, spacing and punctuation stay literal.
 * Retain legacy formatting for receipts already queued before this change.
 */
function telegramMemoryReceiptHtml(markdown: string): string {
  function render(node: ReceiptNode): string {
    const children = () => (node.children ?? []).map(render).join('');
    switch (node.type) {
      case 'root':
        return (node.children ?? []).map(render).join('\n\n');
      case 'paragraph':
      case 'link': // GFM detects bare URLs; keep source snippets literal.
        return children();
      case 'text':
        return escapeHtml(node.value ?? '');
      case 'strong':
        return `<b>${children()}</b>`;
      case 'delete':
        return `<s>${children()}</s>`;
      case 'inlineCode':
        return `<code>${escapeHtml(node.value ?? '')}</code>`;
      case 'code':
        return `<pre><code class="language-diff">${escapeHtml(node.value ?? '')}</code></pre>`;
      case 'html': {
        const details = /^<details><summary>(All changes(?: · \d+\/\d+)?)<\/summary>$/.exec(node.value ?? '');
        if (details) return `<blockquote expandable><b>${escapeHtml(details[1])}</b>`;
        if (node.value === '</details>') return '</blockquote>';
        return escapeHtml(node.value ?? '');
      }
      default:
        throw new Error(`Unexpected memory receipt formatting: ${node.type}`);
    }
  }
  return render(parseMarkdown(markdown));
}

/** Send each already bounded receipt as one native Telegram message. */
export function createTelegramMemoryDeliver(token: string): ChannelAdapter['deliver'] {
  return async (platformId, threadId, message) => {
    const content = message.content as Record<string, unknown>;
    const markdown = String(content.text ?? '');
    const destination = (threadId ?? platformId).split(':');
    const [channel, chatId, encodedTopic] = destination;
    const topicId = encodedTopic ? Number(encodedTopic) : undefined;
    if (
      channel !== 'telegram' ||
      !chatId ||
      destination.length > 3 ||
      (topicId !== undefined && (!Number.isSafeInteger(topicId) || topicId <= 0))
    ) {
      throw new Error('Invalid Telegram memory receipt destination');
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        chat_id: chatId,
        ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
        text: telegramMemoryReceiptHtml(markdown),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(isSilentContent(content) ? { disable_notification: true } : {}),
      }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
      result?: { message_id: number; chat: { id: number } };
    };
    if (!res.ok || !data.ok || !data.result) {
      // Let the durable outbound queue retry. Do not downgrade a failed diff
      // to unformatted text or duplicate it through another sending method.
      const error = new Error(`Telegram memory receipt failed: ${data.description ?? res.status}`);
      if (data.error_code === 429 || res.status === 429) {
        // Match the adapter error contract so a rate limit does not consume
        // the outbound queue's delivery attempt budget.
        Object.assign(error, { name: 'AdapterRateLimitError', retryAfter: data.parameters?.retry_after });
      }
      throw error;
    }
    return `${data.result.chat.id}:${data.result.message_id}`;
  };
}
