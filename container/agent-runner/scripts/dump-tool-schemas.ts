/**
 * Dump OpenAI-shaped tool schemas for context-size measurement.
 *
 * Run from container/agent-runner (requires Bun):
 *   bun scripts/dump-tool-schemas.ts <container.json>
 *
 * Prints JSON to stdout: builtin tools, Luna MCP tools, and any external
 * MCP servers declared in container.json (best-effort connect on the host).
 *
 * Host probes remap container-only binaries (e.g. tavily-mcp from the image)
 * to `npx` with the Dockerfile-pinned version, and merge host .env secrets
 * the container runner injects at spawn (e.g. TAVILY_API_KEY).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import '../src/mcp-tools/probe-register.js';
import { buildRuntimeMcpServers } from '../src/mcp-tools/build-mcp-servers.js';
import { filterMcpToolNames } from '../src/mcp-tools/filter-tools.js';
import { getRegisteredMcpTools } from '../src/mcp-tools/server.js';
import { builtinToolSchemas, type OpenAITool } from '../src/providers/openai/tools/builtin.js';
import { McpBridge } from '../src/providers/openai/tools/mcp-bridge.js';
import type { McpServerConfig } from '../src/providers/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUNA_ROOT = path.resolve(__dirname, '../../..');

let cachedTavilyMcpVersion: string | undefined;

interface ContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  additionalMounts?: Array<{ hostPath: string; containerPath: string }>;
}

interface ToolRow {
  server: string;
  tool: string;
  exposedName: string;
  chars: number;
}

interface DumpResult {
  builtin: { tools: ToolRow[]; totalChars: number };
  mcp: { servers: Record<string, { tools: ToolRow[]; totalChars: number; error?: string }>; totalChars: number };
  grandTotalChars: number;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function schemaChars(schema: OpenAITool): number {
  return JSON.stringify(schema).length;
}

function row(server: string, tool: string, exposedName: string, schema: OpenAITool): ToolRow {
  return { server, tool, exposedName, chars: schemaChars(schema) };
}

function lunaMcpSchemas(lunaPolicy?: McpServerConfig): ToolRow[] {
  const all = getRegisteredMcpTools();
  const allowed = new Set(filterMcpToolNames(all.map((t) => t.name), lunaPolicy));
  return all
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => {
      const exposed = `mcp__luna__${sanitize(tool.name)}`;
      const schema: OpenAITool = {
        type: 'function',
        function: {
          name: exposed,
          description: tool.description ?? `MCP tool ${tool.name} from luna`,
          parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      };
      return row('luna', tool.name, exposed, schema);
    });
}

/** Values meant for inside Docker → reachable from the host probe process. */
function remapValueForHost(value: string): string {
  return value.replaceAll('host.docker.internal', 'localhost');
}

function readLunaEnvKeys(keys: string[]): Record<string, string> {
  const envFile = path.join(LUNA_ROOT, '.env');
  const wanted = new Set(keys);
  const result: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return result;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function tavilyMcpVersionFromDockerfile(): string {
  if (cachedTavilyMcpVersion) return cachedTavilyMcpVersion;
  const dockerfile = path.join(LUNA_ROOT, 'container', 'Dockerfile');
  const content = fs.readFileSync(dockerfile, 'utf-8');
  const match = content.match(/^ARG TAVILY_MCP_VERSION=(\S+)/m);
  cachedTavilyMcpVersion = match?.[1] ?? '0.2.20';
  return cachedTavilyMcpVersion;
}

function commandOnPath(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * MCP commands installed only in the agent image (pnpm global) are not on the
 * host PATH. Use npx with the same pin as container/Dockerfile for measurement.
 */
function remapMcpServerForHost(cfg: McpServerConfig): McpServerConfig {
  if (cfg.command !== 'tavily-mcp') return cfg;

  const env = { ...cfg.env };
  const fromHost = readLunaEnvKeys(['TAVILY_API_KEY']);
  if (fromHost.TAVILY_API_KEY) {
    env.TAVILY_API_KEY = fromHost.TAVILY_API_KEY;
  }

  if (commandOnPath('tavily-mcp')) {
    return { ...cfg, env };
  }

  const version = tavilyMcpVersionFromDockerfile();
  return {
    command: 'npx',
    args: ['-y', `tavily-mcp@${version}`, ...cfg.args],
    env,
  };
}

function remapContainerPaths(
  servers: Record<string, McpServerConfig>,
  mounts: ContainerJson['additionalMounts'],
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.command) continue;
    let remapped = remapMcpServerForHost(cfg);
    const args = remapped.args.map((arg) => {
      if (!arg.startsWith('/workspace/')) return remapValueForHost(arg);
      for (const m of mounts ?? []) {
        const prefix = `/workspace/extra/${m.containerPath}`;
        if (arg === prefix || arg.startsWith(prefix + '/')) {
          return arg.replace(prefix, m.hostPath);
        }
      }
      return arg;
    });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(remapped.env ?? {})) {
      env[k] = remapValueForHost(v);
    }
    out[name] = { ...remapped, args, env };
  }
  return out;
}

async function probeExternalMcp(servers: Record<string, McpServerConfig>): Promise<DumpResult['mcp']> {
  const serversOut: DumpResult['mcp']['servers'] = {};
  let totalChars = 0;

  if (Object.keys(servers).length === 0) {
    return { servers: serversOut, totalChars: 0 };
  }

  const bridge = new McpBridge();
  await bridge.connect(servers);

  for (const [serverName, cfg] of Object.entries(servers)) {
    const tools: ToolRow[] = [];
    for (const schema of bridge.toolSchemas()) {
      const exposed = schema.function.name;
      const prefix = `mcp__${sanitize(serverName)}__`;
      if (!exposed.startsWith(prefix)) continue;
      const tool = exposed.slice(prefix.length);
      tools.push(row(serverName, tool, exposed, schema));
    }
    const serverTotal = tools.reduce((n, t) => n + t.chars, 0);
    totalChars += serverTotal;
    const connectError = bridge.connectErrorsFor(serverName);
    serversOut[serverName] = {
      tools,
      totalChars: serverTotal,
      ...(tools.length === 0
        ? {
            error:
              connectError ??
              `no tools listed (is \`${cfg.command}\` on PATH? try running it manually)`,
          }
        : {}),
    };
  }

  await bridge.close();
  return { servers: serversOut, totalChars };
}

async function main(): Promise<void> {
  const containerPath = process.argv[2];
  if (!containerPath) {
    console.error('Usage: bun scripts/dump-tool-schemas.ts <container.json>');
    process.exit(2);
  }

  const containerJson = JSON.parse(fs.readFileSync(containerPath, 'utf-8')) as ContainerJson;
  const runtimeMcp = buildRuntimeMcpServers(containerJson.mcpServers ?? {}, {
    command: 'bun',
    args: ['run', 'noop'],
    env: {},
  });
  const { luna: lunaRuntime, ...externalRuntime } = runtimeMcp;
  const external = remapContainerPaths(externalRuntime, containerJson.additionalMounts);

  const builtinTools = builtinToolSchemas().map((schema) =>
    row('builtin', schema.function.name, schema.function.name, schema),
  );
  const builtinTotal = builtinTools.reduce((n, t) => n + t.chars, 0);

  const lunaTools = lunaMcpSchemas(lunaRuntime);
  const lunaTotal = lunaTools.reduce((n, t) => n + t.chars, 0);

  const mcp: DumpResult['mcp'] = {
    servers: {
      luna: { tools: lunaTools, totalChars: lunaTotal },
    },
    totalChars: lunaTotal,
  };

  const externalProbe = await probeExternalMcp(external);
  for (const [name, data] of Object.entries(externalProbe.servers)) {
    mcp.servers[name] = data;
    mcp.totalChars += data.totalChars;
  }

  const result: DumpResult = {
    builtin: { tools: builtinTools, totalChars: builtinTotal },
    mcp,
    grandTotalChars: builtinTotal + mcp.totalChars,
  };

  // Measurement helper must be the only stdout (logs go to stderr).
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
