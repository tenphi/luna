import fs from 'fs';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mainProvider: Record<string, unknown> = {};

vi.mock('../config/loader.js', () => ({
  resolveModelRole: () => ({ role: 'main', provider: mainProvider, id: 'gpt-6-luna' }),
}));
vi.mock('../host-mcp/session-api.js', () => ({
  sessionTokenServerName: (sessionId: string) => `session-${sessionId}`,
}));
vi.mock('../host-mcp/tokens.js', () => ({
  readOrCreatePairToken: (agentGroupId: string, serverName: string) => `token-${agentGroupId}-${serverName}`,
}));
vi.mock('../log.js', () => ({ log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { isChatGptProxyRequest, proxyChatGptResponses, readChatGptLogin } from './chatgpt.js';

const NOW = Date.UTC(2030, 0, 15);

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

function writeAuth(dir: string, doc: unknown): string {
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

describe('readChatGptLogin', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-chatgpt-login-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the access token, account, and expiry', () => {
    const accessToken = jwt({ exp: NOW / 1000 + 3600 });
    const file = writeAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken, account_id: 'acct-vulpine', refresh_token: 'never-read' },
    });

    expect(readChatGptLogin(file, NOW)).toEqual({
      status: 'ok',
      login: { accessToken, accountId: 'acct-vulpine', expiresAt: NOW + 3_600_000 },
    });
  });

  it('reports an expired access token instead of using it', () => {
    const file = writeAuth(dir, {
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt({ exp: NOW / 1000 - 1 }), account_id: 'acct-vulpine' },
    });

    expect(readChatGptLogin(file, NOW)).toEqual({ status: 'expired' });
  });

  it('tells an API-key login apart from no login', () => {
    expect(readChatGptLogin(writeAuth(dir, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }), NOW)).toEqual({
      status: 'not-chatgpt',
    });
    expect(readChatGptLogin(path.join(dir, 'absent.json'), NOW)).toEqual({ status: 'missing' });
    expect(readChatGptLogin(writeAuth(dir, '{not json'), NOW)).toEqual({ status: 'unreadable' });
  });
});

describe('proxyChatGptResponses', () => {
  const realFetch = globalThis.fetch;
  let server: Server;
  let base: string;
  let codexHome: string;
  let upstream: { url: string; headers: Headers; body: string }[];
  let upstreamResponse: () => Response;
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const path_ = '/session/group-1/sess-1/chatgpt/responses';
  const sessionToken = 'token-group-1-session-sess-1';

  beforeEach(async () => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-chatgpt-proxy-'));
    writeAuth(codexHome, { auth_mode: 'chatgpt', tokens: { access_token: accessToken, account_id: 'acct-vulpine' } });
    vi.stubEnv('CODEX_HOME', codexHome);
    mainProvider = { name: 'chatgpt', auth: 'chatgpt', baseUrl: 'https://codex.test/backend-api/codex/' };
    upstream = [];
    // Like the backend: a streamed body with no content type.
    upstreamResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
      upstream.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: Buffer.from(init?.body as Uint8Array).toString('utf8'),
      });
      return upstreamResponse();
    }) as typeof fetch;

    server = createServer((req, res) => {
      if (isChatGptProxyRequest(req)) void proxyChatGptResponses(req, res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  function post(body: string, token = sessionToken, route = path_): Promise<Response> {
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
  }

  it('forwards the call with the ChatGPT login and streams the answer back', async () => {
    // Larger than Express's 100 KB JSON limit, which is why the proxy sits in front of it.
    const body = JSON.stringify({ model: 'gpt-6-luna', input: 'x'.repeat(300_000), stream: true, store: false });
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"type":"response.completed"}\n\n');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://codex.test/backend-api/codex/responses');
    expect(upstream[0]!.headers.get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(upstream[0]!.headers.get('chatgpt-account-id')).toBe('acct-vulpine');
    expect(upstream[0]!.headers.get('originator')).toBe('luna');
    expect(upstream[0]!.body).toBe(body);
  });

  it('refuses a caller without the session token', async () => {
    const res = await post('{}', 'token-from-another-session');

    expect(res.status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('refuses when the main model is not configured for ChatGPT', async () => {
    mainProvider = { name: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-main' };
    const res = await post('{}');

    expect(res.status).toBe(404);
    expect(upstream).toHaveLength(0);
  });

  it('explains an expired login in the shape the OpenAI SDK reads', async () => {
    writeAuth(codexHome, {
      auth_mode: 'chatgpt',
      tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }), account_id: 'acct-vulpine' },
    });
    const res = await post('{}');

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('expired');
    expect(upstream).toHaveLength(0);
  });

  it('re-shapes backend refusals so the named parameter survives', async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ detail: 'Unsupported parameter: temperature' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const res = await post('{"temperature":0}');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: 'Unsupported parameter: temperature' } });
  });

  it('answers only POSTs to the Responses route', () => {
    const request = (method: string, url: string) => ({ method, url }) as IncomingMessage;

    expect(isChatGptProxyRequest(request('POST', path_))).toBe(true);
    expect(isChatGptProxyRequest(request('POST', `${path_}?trace=1`))).toBe(true);
    expect(isChatGptProxyRequest(request('GET', path_))).toBe(false);
    expect(isChatGptProxyRequest(request('POST', '/session/group-1/sess-1/chatgpt/decisions'))).toBe(false);
    expect(isChatGptProxyRequest(request('POST', '/session/group-1/sess-1/rpc'))).toBe(false);
  });
});
