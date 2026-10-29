/**
 * ChatGPT subscription access for the agent model.
 *
 * A provider with `auth: "chatgpt"` bills the ChatGPT plan that Codex is signed in to on this Mac
 * instead of an API key. The login never enters a container: the agent calls a Responses endpoint
 * beside its Session API with its own session token, and the host forwards the request to the
 * Codex backend with the account's access token.
 *
 * Codex owns that login. Its refresh tokens rotate on use, so a second refresher would sign one of
 * the two apps out. Luna re-reads Codex's auth file on every request and leaves refreshing to Codex
 * (the ChatGPT app, or `codex login`).
 */
import fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { resolveModelRole } from '../config/loader.js';
import { sessionTokenServerName } from '../host-mcp/session-api.js';
import { readOrCreatePairToken } from '../host-mcp/tokens.js';
import { log } from '../log.js';

export interface ChatGptLogin {
  accessToken: string;
  accountId: string;
  /** Access-token expiry in epoch ms, when the token states one. */
  expiresAt?: number;
}

export type ChatGptLoginProblem = 'missing' | 'not-chatgpt' | 'unreadable' | 'expired';

export type ChatGptLoginState = { status: 'ok'; login: ChatGptLogin } | { status: ChatGptLoginProblem };

const LOGIN_PROBLEMS: Record<ChatGptLoginProblem, string> = {
  missing: 'No ChatGPT login found. Sign in to Codex with a ChatGPT account.',
  'not-chatgpt': 'Codex is signed in with an API key, not a ChatGPT account. Sign in to Codex with ChatGPT.',
  unreadable: 'The Codex login file could not be read. Sign in to Codex again.',
  expired: 'The ChatGPT login has expired. Open Codex or run `codex login` to refresh it.',
};

/** Operator-facing explanation for a login problem. Never contains credential values. */
export function describeChatGptLoginProblem(problem: ChatGptLoginProblem): string {
  return LOGIN_PROBLEMS[problem];
}

/** Codex keeps its login under `$CODEX_HOME`, `~/.codex` by default. */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function tokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Read Codex's ChatGPT login. Never throws. */
export function readChatGptLogin(file = codexAuthPath(), now = Date.now()): ChatGptLoginState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let doc: { auth_mode?: unknown; tokens?: { access_token?: unknown; account_id?: unknown } | null };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    return { status: 'unreadable' };
  }
  const accessToken = doc.tokens?.access_token;
  const accountId = doc.tokens?.account_id;
  if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId) {
    return { status: doc.auth_mode !== undefined && doc.auth_mode !== 'chatgpt' ? 'not-chatgpt' : 'missing' };
  }
  const expiresAt = tokenExpiry(accessToken);
  if (expiresAt !== undefined && expiresAt <= now) return { status: 'expired' };
  return { status: 'ok', login: { accessToken, accountId, ...(expiresAt !== undefined ? { expiresAt } : {}) } };
}

const PROXY_PATH = /^\/session\/([^/]+)\/([^/]+)\/chatgpt\/responses$/;

function proxyPathMatch(req: IncomingMessage): RegExpExecArray | null {
  return req.method === 'POST' ? PROXY_PATH.exec((req.url ?? '').split('?')[0] ?? '') : null;
}

/**
 * Whether {@link proxyChatGptResponses} answers this request. Checked before Express, whose JSON
 * parser caps bodies at 100 KB — a whole conversation with its tools is larger than that.
 */
export function isChatGptProxyRequest(req: IncomingMessage): boolean {
  return proxyPathMatch(req) !== null;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

/**
 * The backend explains a refusal as `{ "detail": … }`, which the OpenAI SDK does not read — every
 * error would surface as "no body", and callers that retry on a named parameter would never see
 * the name. Re-shaped into the API's `{ "error": { "message" } }` by {@link reply}.
 */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } };
    const message = body.error?.message ?? body.detail;
    if (typeof message === 'string' && message) return message;
    if (message !== undefined) return JSON.stringify(message);
  } catch {
    // Not JSON: an HTML block page or a gateway error.
  }
  return `ChatGPT backend returned ${response.status}`;
}

/**
 * Forward one agent Responses call to the Codex backend with the ChatGPT login.
 *
 * Authenticated with the session's Session API token, and refused unless the main model is
 * configured for ChatGPT access, so no container can spend the subscription by default. Request
 * and response bodies carry conversation content and are never logged.
 */
export async function proxyChatGptResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = proxyPathMatch(req);
  if (!match) return reply(res, 404, 'Not found');
  const [, agentGroupId, sessionId] = match;
  if (
    req.headers.authorization !== `Bearer ${readOrCreatePairToken(agentGroupId!, sessionTokenServerName(sessionId!))}`
  ) {
    return reply(res, 401, 'Unauthorized');
  }
  const provider = resolveModelRole('main').provider;
  if (provider.auth !== 'chatgpt' || !provider.baseUrl) {
    return reply(res, 404, 'ChatGPT access is not configured for the main model');
  }
  const state = readChatGptLogin();
  if (state.status !== 'ok') return reply(res, 401, describeChatGptLoginProblem(state.status));

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  // The agent gave up (abort, idle watchdog, container exit): stop paying for the stream.
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) upstream.abort();
  });
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${state.login.accessToken}`,
        'chatgpt-account-id': state.login.accountId,
        originator: 'luna',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: Buffer.concat(chunks),
      signal: upstream.signal,
    });
  } catch (err) {
    if (upstream.signal.aborted) return;
    log.warn('ChatGPT backend unreachable', { error: err instanceof Error ? err.message : String(err) });
    return reply(res, 502, 'ChatGPT backend unreachable');
  }
  if (!response.ok) {
    log.warn('ChatGPT backend refused a request', { status: response.status });
    return reply(res, response.status, await errorMessage(response));
  }

  // The backend streams SSE without a content type; the SDK parses by the request's `stream` flag.
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache',
  });
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import('stream/web').ReadableStream), res);
  } catch {
    // Either side closed mid-stream. The agent's stream watchdog reports it; nothing to add here.
  }
}
