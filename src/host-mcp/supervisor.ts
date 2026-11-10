import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { readStoredContainerConfig } from '../container-config.js';
import { CONTAINER_HOST_GATEWAY } from '../container-runtime.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { deliverSessionNow } from '../delivery.js';
import { isChatGptProxyRequest, proxyChatGptResponses } from '../providers/chatgpt.js';
import { prepareBuiltinProviders } from './builtin-provider.js';
import { runAsCaller, SESSION_ID_HEADER } from './caller-context.js';
import { registerSessionApi } from './session-api.js';
import { isMcpServerDisabled } from './defaults.js';
import { buildHostMcpRegistry } from './registry.js';
import { buildHostOneCliEnv } from './onecli-env.js';
import { loadHostMcpInstallConfig } from './shared/config.js';
import { readOrCreatePairToken } from './tokens.js';
import type { HostMcpProviderDefinition } from './types.js';
import { StdioProviderClient, createStdioProviderBridge, type StdioProviderBridge } from './stdio-provider.js';

interface PairRuntime {
  bridge: StdioProviderBridge;
  transports: Record<string, StreamableHTTPServerTransport>;
}

export interface HostMcpSupervisorState {
  port: number;
  host: string;
}

let state: HostMcpSupervisorState | null = null;
let stopFn: (() => Promise<void>) | null = null;

/** Current host MCP HTTP bridge state, or null when the supervisor is not running. */
export function getHostMcpSupervisorState(): HostMcpSupervisorState | null {
  return state;
}

function pairKey(agentGroupId: string, serverName: string): string {
  return `${agentGroupId}::${serverName}`;
}

async function resolveProviderForGroup(
  agentGroupId: string,
  serverName: string,
): Promise<HostMcpProviderDefinition | null> {
  const registry = buildHostMcpRegistry();
  const provider = registry.providers[serverName];
  if (!provider) return null;

  const group = getAgentGroup(agentGroupId);
  if (!group) return null;
  const stored = readStoredContainerConfig(group);
  const existing = stored.mcpServers[serverName];

  if (provider.kind === 'stdio') {
    return existing?.host === true ? provider : null;
  }

  if (isMcpServerDisabled(existing)) return null;
  return provider;
}

export async function startHostMcpSupervisor(): Promise<HostMcpSupervisorState | null> {
  if (state) return state;

  const installConfig = loadHostMcpInstallConfig();
  const host = '0.0.0.0';
  const pairRuntimes = new Map<string, PairRuntime>();

  const builtins = await prepareBuiltinProviders();

  const app = createMcpExpressApp({
    host,
    allowedHosts: ['127.0.0.1', 'localhost', 'host.docker.internal', '0.0.0.0', CONTAINER_HOST_GATEWAY],
  });

  const ensurePairRuntime = async (agentGroupId: string, serverName: string): Promise<PairRuntime | null> => {
    const key = pairKey(agentGroupId, serverName);
    const existing = pairRuntimes.get(key);
    if (existing) return existing;

    const provider = await resolveProviderForGroup(agentGroupId, serverName);
    if (!provider) return null;

    let bridge: StdioProviderBridge;

    if (provider.kind === 'builtin') {
      const bridgeFactory = builtins.bridges[serverName];
      if (bridgeFactory) {
        bridge = await bridgeFactory();
      } else {
        const factory = builtins.factories[serverName];
        if (!factory) return null;
        bridge = {
          async connectTransport(transport) {
            const server = factory();
            await server.connect(transport);
          },
          async close() {
            // no-op for in-process MCP factories
          },
        };
      }
    } else {
      const cfg = loadHostMcpInstallConfig().servers[serverName];
      if (!cfg) return null;
      const client = new StdioProviderClient(serverName, cfg);
      const extraEnv = cfg.oneCli === false ? undefined : ((await buildHostOneCliEnv(agentGroupId)) ?? undefined);
      if (cfg.oneCli !== false && !extraEnv) return null;
      await client.ensureConnected(extraEnv);
      bridge = createStdioProviderBridge(client);
    }

    const created: PairRuntime = { bridge, transports: {} };
    pairRuntimes.set(key, created);
    return created;
  };

  const unauthorized = (
    res: { status: (n: number) => { json?: (o: unknown) => void; end?: (s?: string) => void } },
    asJson = true,
  ): void => {
    const r = res.status(401);
    if (asJson && r.json) {
      r.json({ error: 'Unauthorized' });
      return;
    }
    r.end?.('Unauthorized');
  };

  const handlePost = async (
    req: {
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      params: { agentGroupId: string; serverName: string };
    },
    res: { status: (n: number) => { json: (o: unknown) => void }; headersSent: boolean },
  ) => {
    const { agentGroupId, serverName } = req.params;
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const expected = readOrCreatePairToken(agentGroupId, serverName);
    if (authHeader !== `Bearer ${expected}`) {
      unauthorized(res);
      return;
    }

    const pair = await ensurePairRuntime(agentGroupId, serverName);
    if (!pair) {
      res.status(404).json({ error: 'Provider not found or disabled for group' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && pair.transports[sessionId]) {
        transport = pair.transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            pair.transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && pair.transports[sid]) delete pair.transports[sid];
        };
        await pair.bridge.connectTransport(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      // Established around the request rather than at construction, because one builtin
      // serves every session in the group. `handleRequest` is awaited here, so a tool
      // handler runs inside this context.
      const claimedSession = req.headers[SESSION_ID_HEADER];
      await runAsCaller(
        {
          agentGroupId,
          ...(typeof claimedSession === 'string' && claimedSession ? { sessionId: claimedSession } : {}),
        },
        () => transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, req.body),
      );
    } catch (err) {
      console.error(`[host-mcp] request error:`, err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const handleGetDelete = async (
    req: {
      headers: Record<string, string | string[] | undefined>;
      params: { agentGroupId: string; serverName: string };
    },
    res: { status: (n: number) => { end: (s: string) => void } },
  ) => {
    const { agentGroupId, serverName } = req.params;
    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const expected = readOrCreatePairToken(agentGroupId, serverName);
    if (authHeader !== `Bearer ${expected}`) {
      res.status(401).end('Unauthorized');
      return;
    }

    const pair = await ensurePairRuntime(agentGroupId, serverName);
    if (!pair) {
      res.status(404).end('Provider not found or disabled for group');
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !pair.transports[sessionId]) {
      res.status(400).end('Invalid or missing session ID');
      return;
    }
    await pair.transports[sessionId].handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  };

  app.post('/mcp/:agentGroupId/:serverName', handlePost as (req: unknown, res: unknown) => Promise<void>);
  app.get('/mcp/:agentGroupId/:serverName', handleGetDelete as (req: unknown, res: unknown) => Promise<void>);
  app.delete('/mcp/:agentGroupId/:serverName', handleGetDelete as (req: unknown, res: unknown) => Promise<void>);

  // Session API — the container's HTTP surface onto its per-session session.db.
  registerSessionApi(
    app as { post: (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => void },
    deliverSessionNow,
  );

  // ChatGPT model calls stream raw bodies far above Express's JSON limit, so they skip the app.
  const httpServer = createServer((req, res) => {
    if (isChatGptProxyRequest(req)) void proxyChatGptResponses(req, res);
    else app(req, res);
  });
  // `app.listen` routed a listen failure to its callback; keep it from becoming an uncaught event.
  httpServer.once('error', (err) => console.error(`[host-mcp] listen failed: ${err.message}`));
  httpServer.listen(installConfig.port, host, () => {
    console.error(`[host-mcp] listening on http://${host}:${installConfig.port}/mcp/:agentGroupId/:serverName`);
  });

  stopFn = async () => {
    for (const pair of pairRuntimes.values()) {
      for (const sid of Object.keys(pair.transports)) {
        try {
          await pair.transports[sid].close();
        } catch {
          /* ignore */
        }
      }
      await pair.bridge.close();
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  };

  state = { port: installConfig.port, host };
  return state;
}

export async function stopHostMcpSupervisor(): Promise<void> {
  if (!state || !stopFn) return;
  await stopFn();
  state = null;
  stopFn = null;
}
