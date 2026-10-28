import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

import type { HostMcpStdioServerConfig } from './shared/config.js';

export interface StdioProviderBridge {
  connectTransport: (transport: Parameters<Server['connect']>[0]) => Promise<void>;
  close: () => Promise<void>;
}

export class StdioProviderClient {
  private client: Client | null = null;
  private tools: Tool[] = [];

  constructor(
    private readonly name: string,
    private readonly config: HostMcpStdioServerConfig,
  ) {}

  private resolvedCommand(): string {
    const cmd = this.config.command;
    if (cmd === 'node') return process.execPath;
    return cmd;
  }

  async ensureConnected(extraEnv?: Record<string, string>): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: this.resolvedCommand(),
      args: this.config.args ?? [],
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...(this.config.env ?? {}),
        ...(extraEnv ?? {}),
      } as Record<string, string>,
    });
    const client = new Client({ name: `host-mcp-${this.name}`, version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    this.tools = listed.tools as Tool[];
    this.client = client;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client) return [];
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error(`External MCP "${this.name}" not connected`);
    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = null;
      this.tools = [];
    }
  }
}

export function createStdioProviderBridge(client: StdioProviderClient): StdioProviderBridge {
  return {
    async connectTransport(transport) {
      const server = new Server({ name: 'host-mcp-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await client.listTools()) as Tool[],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        return (await client.callTool(name, args)) as any;
      });
      await server.connect(transport);
    },
    close: async () => {
      await client.close();
    },
  };
}
