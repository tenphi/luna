/**
 * Chat client for the runner's own background model work — episode topic
 * classification, attachment digests, and episode summarization.
 *
 * Points at whatever the host resolved for `models.memory`. Two roles, because
 * the fallbacks differ when that role is unset (see `resolveMemoryModelConfig`
 * host-side): `'chat'` decides what a turn *is* and may need vision, so it falls
 * back to the main chat model; `'summary'` is bulk low-stakes work and falls
 * back to the memory endpoint, typically a small local server. Either way no
 * call here spends main-model tokens once `models.memory` is set.
 */
import OpenAI, { APIError } from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { Response as ModelResponse, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';

import { loadConfig, type RunnerMemoryModels } from '../../../config.js';
import type { ImageAttachment } from '../../../image-attachments.js';
import { responsesInput } from '../responses.js';
import type { ChatMessage, ContentPart } from '../types.js';
import { buildUserContent } from '../vision.js';

/** Which background job is calling — decides the fallback when `models.memory` is unset. */
export type MemoryModelRole = 'chat' | 'summary';

export interface ResolvedMemoryModel {
  baseURL: string;
  apiKey: string;
  model: string;
  /** True when no memory model was configured and we fell back to the main model. */
  fromMain: boolean;
  /** Set when the endpoint serves only Responses (the host's ChatGPT proxy has no Chat Completions). */
  api?: 'responses';
}

export interface MemoryChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

export interface MemoryChatOptions {
  /** Ask for a JSON object; silently downgraded on endpoints that reject it. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Which endpoint to use. Defaults to `'chat'`. */
  role?: MemoryModelRole;
  /**
   * Images to append to the last user message as `image_url` parts. Silently
   * ignored when the resolved model has no vision head — the endpoint either
   * 400s (handled below) or answers about the text alone.
   */
  images?: ImageAttachment[];
  /** Internal: set on the one retry that widens the token allowance. */
  retriedForLength?: boolean;
}

/**
 * One client per endpoint. A single slot was enough while every role shared the
 * memory endpoint; with `chat` and `summary` free to differ, a single slot would
 * thrash a new OpenAI instance on every alternating call.
 */
const clients = new Map<string, OpenAI>();
/** Endpoints that rejected `response_format`, so we stop sending it *there*. */
const jsonModeUnsupported = new Set<string>();
/** Endpoints that rejected `reasoning_effort`, same reasoning. */
const effortNoneUnsupported = new Set<string>();
/**
 * Endpoints that want `max_completion_tokens` instead of `max_tokens`.
 *
 * Newer OpenAI models reject `max_tokens` outright, which fails the *whole*
 * call — so unlike the two probes above this one is not a nicety. Left
 * unhandled it takes every background job down: summaries go silent, and
 * classification only survives because `classifierChat` pays for a main-model
 * call behind it, which is the cost the memory model exists to avoid.
 */
const legacyMaxTokensUnsupported = new Set<string>();

function log(msg: string): void {
  console.error(`[memory-model] ${msg}`);
}

function endpointKey(resolved: ResolvedMemoryModel): string {
  return `${resolved.baseURL}|${resolved.apiKey}`;
}

/**
 * Resolve endpoint + model for a role. Arguments are injectable for tests.
 *
 * `'chat'` prefers `models.memory` then the main provider env; `'summary'`
 * prefers `models.memory` then the host-resolved memory endpoint, then the main
 * provider env. A role with a model but no base URL is unusable, so it degrades
 * to the next candidate rather than half-configuring a client.
 */
export function resolveMemoryModel(
  memory: RunnerMemoryModels | undefined = loadConfig().memory,
  env: Record<string, string | undefined> = process.env,
  role: MemoryModelRole = 'chat',
): ResolvedMemoryModel | null {
  const configured: { model?: string; baseURL?: string; apiKey?: string }[] =
    role === 'summary'
      ? [
          { model: memory?.chatModel, baseURL: memory?.baseUrl, apiKey: memory?.apiKey },
          { model: memory?.summaryModel, baseURL: memory?.summaryBaseUrl, apiKey: memory?.summaryApiKey },
        ]
      : [{ model: memory?.chatModel, baseURL: memory?.baseUrl, apiKey: memory?.apiKey }];

  for (const candidate of configured) {
    if (candidate.model && candidate.baseURL) {
      return {
        baseURL: candidate.baseURL,
        // Local servers usually need no key, and the SDK rejects an empty string.
        apiKey: candidate.apiKey || 'sk-no-key-required',
        model: candidate.model,
        fromMain: false,
      };
    }
  }

  if (!env.OPENAI_MODEL || !env.OPENAI_BASE_URL) return null;
  return {
    baseURL: env.OPENAI_BASE_URL,
    apiKey: env.OPENAI_API_KEY || 'sk-no-key-required',
    model: env.OPENAI_MODEL,
    fromMain: true,
    ...(env.OPENAI_API === 'responses' ? { api: 'responses' as const } : {}),
  };
}

function memoryClient(resolved: ResolvedMemoryModel): OpenAI {
  const key = endpointKey(resolved);
  let existing = clients.get(key);
  if (!existing) {
    existing = new OpenAI({ baseURL: resolved.baseURL, apiKey: resolved.apiKey, maxRetries: 0 });
    clients.set(key, existing);
    log(`Using ${resolved.model} at ${resolved.baseURL}${resolved.fromMain ? ' (main model fallback)' : ''}`);
  }
  return existing;
}

/**
 * A surrogate half left behind by truncating mid-emoji. Invalid UTF-16, and
 * endpoints that re-parse the request as JSON reject the whole call over it.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/** Apply {@link stripLoneSurrogates} to a string body or every text part. */
function sanitizeContent(content: string | ContentPart[]): string | ContentPart[] {
  if (typeof content === 'string') return stripLoneSurrogates(content);
  return content.map((part) => (part.type === 'text' ? { ...part, text: stripLoneSurrogates(part.text) } : part));
}

/**
 * Append image parts to the last user message. Reuses `buildUserContent` so the
 * data-URI encoding matches the main agent's vision path byte-for-byte.
 */
function withImages(messages: MemoryChatMessage[], images: ImageAttachment[] | undefined): MemoryChatMessage[] {
  if (!images?.length) return messages;
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUser === -1) return messages;

  const target = messages[lastUser]!;
  const text =
    typeof target.content === 'string'
      ? target.content
      : target.content
          .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
  const built = buildUserContent(text, images);
  if (typeof built === 'string') return messages;
  return messages.map((m, i) => (i === lastUser ? { ...m, content: built } : m));
}

/** Did the endpoint reject this specific optional parameter? */
function mentionsParam(err: APIError, param: string): boolean {
  return `${err.message} ${JSON.stringify(err.error ?? '')}`.includes(param);
}

/**
 * One non-streaming completion. Returns null on any failure — every caller is
 * a background nicety and must degrade rather than break the turn.
 */
export async function memoryChat(
  messages: MemoryChatMessage[],
  opts: MemoryChatOptions = {},
): Promise<string | null> {
  const role = opts.role ?? 'chat';
  const resolved = resolveMemoryModel(undefined, undefined, role);
  if (!resolved) {
    log(`No ${role} model configured`);
    return null;
  }
  if (resolved.api === 'responses') return memoryResponse(resolved, messages, opts);
  const endpoint = endpointKey(resolved);

  const wantsJson = opts.json === true && !jsonModeUnsupported.has(endpoint);
  const maxTokens = opts.maxTokens ?? 200;
  const body = {
    model: resolved.model,
    messages: withImages(messages, opts.images).map((m) => ({ ...m, content: sanitizeContent(m.content) })),
    ...(legacyMaxTokensUnsupported.has(endpoint)
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    temperature: opts.temperature ?? 0,
    ...(wantsJson ? { response_format: { type: 'json_object' as const } } : {}),
    // Classification and summarization are labelling jobs, not puzzles. A
    // thinking model left to itself spends its whole allowance reasoning and
    // returns empty content — and takes 5x as long to reach the same answer.
    ...(effortNoneUnsupported.has(endpoint) ? {} : { reasoning_effort: 'none' }),
  } as ChatCompletionCreateParamsNonStreaming;

  try {
    const res = await memoryClient(resolved).chat.completions.create(body, { signal: opts.signal });
    const choice = res.choices[0];
    const content = choice?.message?.content?.trim() || null;
    if (content) return content;

    // Empty content is not an error the SDK raises, and callers only see
    // "no response" — say what the endpoint actually did.
    const finish = choice?.finish_reason ?? 'none';
    const reasoningChars = String(
      (choice?.message as { reasoning_content?: unknown } | undefined)?.reasoning_content ?? '',
    ).length;
    log(`Empty completion from ${resolved.model} (finish_reason=${finish}, reasoning=${reasoningChars} chars)`);

    // A thinking model can spend the whole allowance before it starts the
    // answer. One retry with room to finish, then give up.
    if (!opts.retriedForLength && (finish === 'length' || reasoningChars > 0)) {
      log('Retrying with a larger token allowance');
      return memoryChat(messages, {
        ...opts,
        maxTokens: (opts.maxTokens ?? 200) * 4,
        retriedForLength: true,
      });
    }
    return null;
  } catch (err) {
    // Endpoints reject the optional params we send with a 400. Drop the one
    // the endpoint names and remember, so each is probed once per container;
    // an unrelated 400 must not disable both for the container's life.
    if (err instanceof APIError && err.status === 400 && mentionsParam(err, 'response_format')) {
      if (wantsJson) {
        jsonModeUnsupported.add(endpoint);
        log('Endpoint rejected JSON mode — retrying without response_format');
        return memoryChat(messages, { ...opts, json: false });
      }
    }
    // Renamed rather than dropped — the allowance is what keeps a thinking
    // model from spending the whole answer on reasoning. `max_completion_tokens`
    // does not contain `max_tokens`, so this cannot fire on its own rename.
    if (err instanceof APIError && err.status === 400 && mentionsParam(err, 'max_tokens')) {
      if (!legacyMaxTokensUnsupported.has(endpoint)) {
        legacyMaxTokensUnsupported.add(endpoint);
        log('Endpoint rejected max_tokens — retrying with max_completion_tokens');
        return memoryChat(messages, opts);
      }
    }
    if (err instanceof APIError && err.status === 400 && mentionsParam(err, 'reasoning_effort')) {
      if (!effortNoneUnsupported.has(endpoint)) {
        effortNoneUnsupported.add(endpoint);
        log('Endpoint rejected reasoning_effort — retrying without it');
        return memoryChat(messages, opts);
      }
    }
    // A model with no vision head rejects the image parts rather than the whole
    // request shape. Retrying text-only beats losing the answer: a digest of the
    // filename and any OCR text is still better than nothing.
    if (opts.images?.length && err instanceof APIError && err.status === 400) {
      log(`Endpoint rejected image input (${resolved.model}) — retrying without images`);
      return memoryChat(messages, { ...opts, images: undefined });
    }
    log(`Call failed (${resolved.model} at ${resolved.baseURL}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * {@link memoryChat} over Responses, for a main endpoint without Chat Completions. The ChatGPT
 * backend accepts only streams and refuses `temperature`, so this path always streams and never
 * sends one. Retries mirror the Chat Completions path.
 */
async function memoryResponse(
  resolved: ResolvedMemoryModel,
  messages: MemoryChatMessage[],
  opts: MemoryChatOptions,
): Promise<string | null> {
  const endpoint = endpointKey(resolved);
  const maxTokens = opts.maxTokens ?? 200;
  const params = {
    model: resolved.model,
    input: responsesInput(
      withImages(messages, opts.images).map((m) => ({ role: m.role, content: sanitizeContent(m.content) }) as ChatMessage),
    ),
    max_output_tokens: maxTokens,
    ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
    // Labelling, not puzzles — see memoryChat.
    ...(effortNoneUnsupported.has(endpoint) ? {} : { reasoning: { effort: 'none' } }),
    store: false,
    stream: true,
    // responsesInput emits wire-shaped items, wider than the SDK's input union.
  } as unknown as ResponseCreateParamsStreaming;

  try {
    const stream = await memoryClient(resolved).responses.create(params, { signal: opts.signal });
    let response: ModelResponse | undefined;
    for await (const event of stream) {
      if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
    }
    const content = (response?.output ?? [])
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .map((part) => (part.type === 'output_text' ? part.text : ''))
      .join('')
      .trim();
    if (content) return content;

    const reason = response?.incomplete_details?.reason ?? response?.status ?? 'no response';
    log(`Empty response from ${resolved.model} (${reason})`);
    if (!opts.retriedForLength && reason === 'max_output_tokens') {
      log('Retrying with a larger token allowance');
      return memoryChat(messages, { ...opts, maxTokens: maxTokens * 4, retriedForLength: true });
    }
    return null;
  } catch (err) {
    if (err instanceof APIError && err.status === 400 && mentionsParam(err, 'reasoning')) {
      if (!effortNoneUnsupported.has(endpoint)) {
        effortNoneUnsupported.add(endpoint);
        log('Endpoint rejected reasoning effort — retrying without it');
        return memoryChat(messages, opts);
      }
    }
    if (opts.images?.length && err instanceof APIError && err.status === 400) {
      log(`Endpoint rejected image input (${resolved.model}) — retrying without images`);
      return memoryChat(messages, { ...opts, images: undefined });
    }
    log(`Call failed (${resolved.model} at ${resolved.baseURL}): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Small models emit two recurring kinds of near-JSON: a duplicated empty
 * container after a value (`"openThreads":[…][]`) and a trailing comma. Both are
 * unambiguous, so repairing them beats discarding an otherwise good answer.
 */
function repairJson(json: string): string {
  return json.replace(/([\]}])\s*(?:\[\s*\]|\{\s*\})/g, '$1').replace(/,\s*([\]}])/g, '$1');
}

/** Pull the first JSON object out of a model reply (code fences, stray prose). */
export function parseJsonObject<T>(text: string | null): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const json = text.slice(start, end + 1);
  try {
    return JSON.parse(json) as T;
  } catch {
    try {
      return JSON.parse(repairJson(json)) as T;
    } catch {
      return null;
    }
  }
}

export function resetMemoryClientForTests(): void {
  clients.clear();
  jsonModeUnsupported.clear();
  effortNoneUnsupported.clear();
  legacyMaxTokensUnsupported.clear();
}
