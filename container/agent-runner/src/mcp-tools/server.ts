import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDefinition } from './types.js';
import { withMcpBatch } from '../current-batch.js';

const definitions: Record<string, McpToolDefinition> = Object.create(null);
export function registerTools(additions: McpToolDefinition[]): void {
  for (const definition of additions) {
    const name = definition.tool.name;
    if (Object.hasOwn(definitions, name)) console.error(`[mcp-tools] ${name} is already registered`);
    else definitions[name] = definition;
  }
}
export const getRegisteredMcpTools = (): Tool[] => Object.values(definitions).map((definition) => definition.tool);

export async function startMcpServer(): Promise<void> {
  const connection = new Server({ name: 'luna', version: '0.1.15' }, { capabilities: { tools: {} } });
  connection.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getRegisteredMcpTools() }));
  connection.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const definition = definitions[params.name];
    if (definition) return withMcpBatch(params._meta, () => definition.handler(params.arguments ?? {}));
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
  });
  await connection.connect(new StdioServerTransport());
}
