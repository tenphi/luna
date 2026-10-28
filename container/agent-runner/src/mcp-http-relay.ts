/**
 * Generic stdio ↔ Streamable HTTP MCP relay.
 *
 * Env:
 *   - MCP_RELAY_URL (required)
 *   - MCP_RELAY_TOKEN (required bearer token)
 *   - MCP_RELAY_SESSION_ID (optional) — names which session is calling, so a host tool that
 *     takes a `/workspace/...` path can resolve it against this session's mount. The token
 *     authenticates the *group*; this only ever selects a folder inside it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

function log(msg: string): void {
  console.error(`[mcp-http-relay] ${msg}`);
}

async function main(): Promise<void> {
  const url = process.env.MCP_RELAY_URL;
  const token = process.env.MCP_RELAY_TOKEN;
  if (!url) {
    log('MCP_RELAY_URL is required');
    process.exit(1);
  }
  if (!token) {
    log('MCP_RELAY_TOKEN is required');
    process.exit(1);
  }

  const sessionId = process.env.MCP_RELAY_SESSION_ID;
  const upstream = new Client({ name: 'mcp-http-relay', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(sessionId ? { 'X-Luna-Session-Id': sessionId } : {}),
      },
    },
  });
  await upstream.connect(transport);
  log(`Connected to ${url}`);

  const { tools: upstreamTools } = await upstream.listTools();
  const server = new Server({ name: 'mcp-http-relay', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: upstreamTools as Tool[] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Leave a margin for the outer bridge to receive the result and close its
    // own 300-second request. Progress never extends either absolute deadline.
    try {
      return await upstream.callTool({ name, arguments: args ?? {} }, undefined, {
        timeout: 285_000,
        resetTimeoutOnProgress: false,
      });
    } catch (err) {
      // Keep transport uncertainty distinct from a tool's own `isError` result. The outer
      // bridge may replay a receipt-backed mutation using its exact idempotency key.
      const message = err instanceof Error ? err.message : String(err);
      const kind = /abort|cancel/i.test(message)
        ? 'cancelled'
        : /timeout|timed out|deadline/i.test(message)
          ? 'deadline exceeded'
          : 'connection lost';
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `LUNA_RELAY_TRANSPORT_UNCERTAIN:${kind}: ${message}` }],
      };
    }
  });

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  log(`Relaying ${upstreamTools.length} tools over stdio`);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
