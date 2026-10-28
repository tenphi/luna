/** Responses transport for the existing tool loop, with stateless reasoning replay. */
import type { ChatMessage, ToolCall } from './types.js';
import type { OpenAITool } from './tools/builtin.js';
import type { ProviderEvent } from '../types.js';
import type { CompletionUsage } from './context.js';
import { anySignal, withIdleWatchdog } from './stream-watchdog.js';

export interface ResponsesClient {
  create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface ResponsesTurn {
  text: string;
  toolCalls: ToolCall[];
  responseItems: Record<string, unknown>[];
  reasoning?: string;
  finishReason: string;
  usage?: CompletionUsage;
}

/** Preserve original output order, encrypted reasoning, function IDs and assistant phase. */
export function responsesInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.response_items?.length) {
      input.push(...message.response_items);
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.content !== null && message.content !== '') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) =>
              part.type === 'image_url'
                ? { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' }
                : { type: 'input_text', text: part.text },
            );
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

function result(response: Record<string, any>): ResponsesTurn {
  if (response.status !== 'completed') {
    throw new Error(`Responses request did not complete (${response.status ?? 'unknown status'})`);
  }
  const output = Array.isArray(response.output) ? (response.output as Record<string, any>[]) : [];
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => (part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : ''))
    .join('');
  const toolCalls: ToolCall[] = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments },
    }));
  if (toolCalls.some((call) => !call.id || !call.function.name || typeof call.function.arguments !== 'string')) {
    throw new Error('Responses returned an invalid function call');
  }
  const u = response.usage;
  return {
    text,
    toolCalls,
    responseItems: output,
    reasoning: output.some((item) => item.type === 'reasoning') ? '[opaque reasoning state]' : '',
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    ...(u
      ? {
          usage: {
            promptTokens: u.input_tokens,
            completionTokens: u.output_tokens,
            cachedTokens: u.input_tokens_details?.cached_tokens,
            cachedTokensKnown: typeof u.input_tokens_details?.cached_tokens === 'number',
          },
        }
      : {}),
  };
}

export async function* responsesCompletion(
  client: ResponsesClient,
  options: {
    model: string;
    messages: ChatMessage[];
    tools: OpenAITool[];
    effort?: string;
    extraBody: Record<string, unknown>;
    cacheKey?: string;
    finalizing: boolean;
    idleMs: number;
    onTick: () => void;
  },
  ctrl: { signal: AbortSignal; isAborted: () => boolean },
): AsyncGenerator<ProviderEvent, ResponsesTurn> {
  const params: Record<string, unknown> = {
    model: options.model,
    input: responsesInput(options.messages),
    tools: options.tools.map((tool) => ({ type: 'function', ...tool.function, strict: false })),
    stream: true,
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
    ...(options.cacheKey ? { prompt_cache_key: options.cacheKey } : {}),
    ...options.extraBody,
    // Luna owns session state. Never create provider-side stored conversations.
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (options.finalizing) {
    params.tools = [];
    params.tool_choice = 'none';
    delete params.parallel_tool_calls;
  }
  const idleAbort = new AbortController();
  const response = await client.create(params, { signal: anySignal(ctrl.signal, idleAbort.signal) });
  yield { type: 'effort', effort: String((params.reasoning as { effort?: string } | undefined)?.effort ?? 'default') };
  if (params.stream === false) return result(response as Record<string, unknown>);
  let completed: Record<string, any> | undefined;
  let text = '';
  let lastEmit = 0;
  // Responses output indices also count reasoning and commentary items. The host
  // expects contiguous tool indices matching the dispatch order.
  let toolIndex = 0;
  const watched = withIdleWatchdog(response as AsyncIterable<Record<string, any>>, {
    idleMs: options.idleMs,
    onTick: options.onTick,
    onIdle: () => idleAbort.abort(),
  });
  for await (const event of watched) {
    if (ctrl.isAborted()) break;
    yield { type: 'activity' };
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      yield { type: 'tool_compose', index: toolIndex++, name: event.item.name };
    }
    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      if (Date.now() - lastEmit >= 300) {
        yield { type: 'phase', phase: 'generating', text };
        lastEmit = Date.now();
      }
    }
    if (event.type === 'response.completed') completed = event.response;
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      // Provider diagnostics may echo request content. Keep this failure content-free.
      throw new Error('Responses request failed or was incomplete');
    }
  }
  if (ctrl.isAborted()) throw new DOMException('Aborted', 'AbortError');
  if (!completed) throw new Error('Responses stream ended without a completed response');
  return result(completed);
}
