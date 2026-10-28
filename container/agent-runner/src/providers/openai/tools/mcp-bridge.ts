/**
 * MCP → OpenAI tool bridge.
 *
 * Spawns each configured stdio MCP server, lists its tools, and exposes them
 * as OpenAI function tools under domain-prefixed names (`get_memory_page`,
 * `list_calendar_events`). Legacy `mcp__server__tool` names remain callable
 * for in-flight sessions and stale skill text.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../../../db/connection.js';
import { currentBatchMeta, getCurrentInReplyTo } from '../../../current-batch.js';
import { filterMcpToolNamesWithWarnings } from '../../../mcp-tools/filter-tools.js';
import type { McpServerConfig } from '../../types.js';
import type { OpenAITool } from './builtin.js';
import {
  exposeToolName,
  legacyMcpToolName,
  resolveToolName,
  sanitizeToolSegment,
  serverDisplayName,
} from './tool-aliases.js';
import { normalizeMemoryToolArgs } from './memory-slug.js';

function log(msg: string): void {
  console.error(`[openai-mcp-bridge] ${msg}`);
}

/** @deprecated Prefer exposeToolName — kept for callers that still build legacy names. */
/**
 * How long a host tool may take before the bridge gives up on it.
 *
 * The SDK's default is 60 seconds, which is not a considered number for these tools — it is the
 * number that happened to be there. A `memory_remember` runs a curator, routes the claim by search
 * and checks it for conflicts; an `ingest` OCRs a scan. Both have legitimately taken longer than a
 * minute, and when they did the agent was told the call failed while the work went on and
 * completed — so the user was told their note was lost, and it was not.
 *
 * Five minutes is past anything that is working, and short enough that something genuinely wedged
 * still ends the turn.
 */
const TOOL_CALL_OPTIONS = { timeout: 300_000, resetTimeoutOnProgress: false } as const;
const RECEIPT_OPS = new Set(['write', 'move', 'forget', 'folder']);
const RELAY_TRANSPORT_MARKER = 'LUNA_RELAY_TRANSPORT_UNCERTAIN:';

function relayTransportFailure(result: unknown): Error | null {
  const reply = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  const text = reply?.content?.find((item) => item.type === 'text')?.text;
  return reply?.isError && text?.startsWith(RELAY_TRANSPORT_MARKER)
    ? new Error(text.slice(RELAY_TRANSPORT_MARKER.length))
    : null;
}

function replayStillUncertain(result: unknown): boolean {
  const reply = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (!reply?.isError) return false;
  const text =
    reply.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n') ?? '';
  return /idempotency key.*(?:still running|may already have changed)/i.test(text);
}

function isCancellation(err: unknown): boolean {
  return /abort|cancel/i.test(err instanceof Error ? `${err.name} ${err.message}` : String(err));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One logical inbound request and one exact mutation share a replay receipt. */
export function memoryMutationArgs(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  inboundId: string | null,
): Record<string, unknown> {
  if (server !== 'memory') return args;
  const normalized = normalizeMemoryToolArgs(args);
  if (!RECEIPT_OPS.has(tool) || !inboundId) return normalized;
  const { idempotency_key: _ignored, ...canonical } = normalized;
  const key = createHash('sha256')
    .update(`${inboundId}\0${tool}\0${stableJson(canonical)}`)
    .digest('hex');
  return { ...canonical, idempotency_key: `luna:${key}` };
}

export function memoryTransportFailure(toolName: string, err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  const kind = /abort|cancel/i.test(name + ' ' + message)
    ? 'cancelled'
    : /timeout|timed out|deadline/i.test(name + ' ' + message)
      ? 'deadline exceeded'
      : 'connection lost';
  return `MCP tool error (${toolName}): ${kind}; commit outcome unknown. Repeat the exact same call to reconcile its replay receipt before claiming success or failure. ${message}`;
}

interface BridgedTool {
  server: string;
  toolName: string;
}

export class McpBridge {
  private clients = new Map<string, Client>();
  /** Exposed (and legacy) OpenAI tool name → { server, toolName }. */
  private toolIndex = new Map<string, BridgedTool>();
  private schemas: OpenAITool[] = [];
  private connectErrors = new Map<string, string>();
  /** Filtered raw MCP tool names per server (after connect). */
  private filteredNamesByServer = new Map<string, string[]>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private reconnecting = new Map<string, Promise<Client>>();

  /** Last connection error per server name (empty when connect succeeded). */
  connectErrorsFor(serverName: string): string | undefined {
    return this.connectErrors.get(serverName);
  }

  /** Raw MCP tool names exposed per server (post-filter). */
  filteredToolNamesByServer(): ReadonlyMap<string, string[]> {
    return this.filteredNamesByServer;
  }

  /** Connect to every configured MCP server and enumerate its tools. */
  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.close();
    this.toolIndex.clear();
    this.schemas = [];
    this.connectErrors.clear();
    this.filteredNamesByServer.clear();
    this.serverConfigs = new Map(Object.entries(servers));
    for (const [serverName, cfg] of Object.entries(servers)) {
      if (!cfg.command) {
        log(`Skipping MCP server "${serverName}": no command (filter-only entry?)`);
        continue;
      }
      try {
        const transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
        });
        const client = new Client({ name: `luna-openai-bridge-${serverName}`, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        this.clients.set(serverName, client);

        const { tools } = await client.listTools();
        const { filtered, unknownAllow } = filterMcpToolNamesWithWarnings(
          tools.map((t) => t.name),
          cfg,
        );
        if (unknownAllow.length > 0) {
          log(`MCP server "${serverName}": toolsAllow names not on server: ${unknownAllow.join(', ')}`);
        }

        const allowSet = new Set(filtered);
        const bridged: Tool[] = tools.filter((t) => allowSet.has(t.name));
        this.filteredNamesByServer.set(serverName, filtered);

        for (const tool of bridged) {
          const exposed = exposeToolName(serverName, tool.name);
          const legacy = legacyMcpToolName(serverName, tool.name);
          const entry = { server: serverName, toolName: tool.name };
          this.toolIndex.set(exposed, entry);
          this.toolIndex.set(legacy, entry);
          this.schemas.push({
            type: 'function',
            function: {
              name: exposed,
              description: tool.description ?? `MCP tool ${tool.name} from ${serverDisplayName(serverName)}`,
              parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            },
          });
        }
        const suffix = bridged.length !== tools.length ? ` (${bridged.length}/${tools.length} tools after filter)` : '';
        log(`Connected MCP server "${serverName}"${suffix}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.connectErrors.set(serverName, message);
        log(`Failed to connect MCP server "${serverName}": ${message}`);
      }
    }
  }

  /** OpenAI tool schemas for all bridged MCP tools (domain-prefixed names). */
  toolSchemas(): OpenAITool[] {
    return this.schemas;
  }

  /** True if `name` is a bridged MCP tool (exposed or legacy). */
  has(name: string): boolean {
    if (this.toolIndex.has(name)) return true;
    const resolved = resolveToolName(name);
    return resolved !== name && this.toolIndex.has(resolved);
  }

  /** True when an MCP server connected successfully (has an open client). */
  hasConnectedServer(serverName: string): boolean {
    return this.clients.has(serverName);
  }

  /**
   * Invoke a raw MCP tool by server + upstream name, bypassing toolsAllow /
   * model-visible schemas. Used for system-owned calls such as extract_facts.
   */
  async callRaw(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) return `MCP server not connected: ${serverName}`;
    try {
      setContainerToolInFlight(`${serverName}:${toolName}`, null);
    } catch {
      /* best-effort */
    }
    try {
      const result = await client.callTool({ name: toolName, arguments: args, _meta: currentBatchMeta(serverName) }, undefined, TOOL_CALL_OPTIONS);
      return flattenResult(result, toolName);
    } catch (err) {
      return `MCP tool error (${toolName}): ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        clearContainerToolInFlight();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Invoke a bridged MCP tool and flatten its result to text. */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(name) ?? this.toolIndex.get(resolveToolName(name));
    if (!entry) return `Unknown MCP tool: ${name}`;
    const client = this.clients.get(entry.server);
    if (!client) return `MCP server not connected: ${entry.server}`;
    // Mark in-flight so the host typing indicator + sweep stay alive during
    // long host-MCP calls (e.g. Calendar osascript) that emit no SSE events.
    let callArgs: Record<string, unknown> | null = null;
    const deadline = Date.now() + TOOL_CALL_OPTIONS.timeout;
    try {
      setContainerToolInFlight(name, null);
    } catch {
      /* best-effort */
    }
    try {
      // Agents often pass filesystem-style slugs (`people/jane.md`), and a write of that slug
      // produces `people/jane.md.md`. This asked for the previous backend's server name, so
      // after the move it normalized nothing at all.
      callArgs = memoryMutationArgs(entry.server, entry.toolName, args, getCurrentInReplyTo());
      const result = await client.callTool({ name: entry.toolName, arguments: callArgs, _meta: currentBatchMeta(entry.server) }, undefined, TOOL_CALL_OPTIONS);
      const relayError = relayTransportFailure(result);
      if (relayError) throw relayError;
      return flattenResult(result, name);
    } catch (err) {
      if (entry.server === 'memory' && RECEIPT_OPS.has(entry.toolName)) {
        // Only a key admitted by Akno makes a second call safe. Keep the original deadline;
        // progress and retries must never turn one request into an unbounded background job.
        if (callArgs?.idempotency_key && !isCancellation(err)) {
          const remaining = deadline - Date.now();
          if (remaining > 2_000) {
            try {
              const reopened = await this.reopenServer(entry.server, Math.min(remaining - 1_000, 10_000));
              const retryBudget = deadline - Date.now() - 1_000;
              if (retryBudget > 1_000) {
                const result = await reopened.callTool({ name: entry.toolName, arguments: callArgs }, undefined, {
                  timeout: retryBudget,
                  resetTimeoutOnProgress: false,
                });
                const relayError = relayTransportFailure(result);
                if (relayError) throw relayError;
                if (replayStillUncertain(result)) {
                  return `MCP tool error (${name}): replay receipt is still running or interrupted; commit outcome unknown. Inspect the recorded change or retry this exact call before claiming success or failure.`;
                }
                return flattenResult(result, name);
              }
            } catch (reconcileError) {
              return memoryTransportFailure(name, reconcileError);
            }
          }
        }
        return memoryTransportFailure(name, err);
      }
      return `MCP tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        clearContainerToolInFlight();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Replace only the failed relay, leaving other MCP calls and exposed schemas intact. */
  private async reopenServer(serverName: string, timeoutMs: number): Promise<Client> {
    const pending = this.reconnecting.get(serverName);
    if (pending) return pending;
    const cfg = this.serverConfigs.get(serverName);
    if (!cfg?.command) throw new Error(`MCP server configuration missing: ${serverName}`);
    const attempt = (async () => {
      const transport = new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args ?? [],
        env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      });
      const replacement = new Client(
        { name: `luna-openai-bridge-${serverName}`, version: '1.0.0' },
        { capabilities: {} },
      );
      try {
        await replacement.connect(transport, { timeout: timeoutMs, resetTimeoutOnProgress: false });
      } catch (err) {
        await replacement.close().catch(() => {});
        throw err;
      }
      const previous = this.clients.get(serverName);
      this.clients.set(serverName, replacement);
      await previous?.close().catch(() => {});
      return replacement;
    })();
    this.reconnecting.set(serverName, attempt);
    try {
      return await attempt;
    } finally {
      this.reconnecting.delete(serverName);
    }
  }

  /** Close all MCP client connections. */
  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
    this.clients.clear();
  }

  /** Reconnect servers and rebuild exposed tool index/schemas. */
  async reconnect(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.connect(servers);
  }
}

/**
 * Flatten an MCP CallToolResult to agent-facing text.
 * `isError: true` uses the same prefix as thrown call failures so the agent
 * loop and wrappers (e.g. edit_memory_page) treat it as a hard failure.
 */
export function flattenResult(result: unknown, toolName = 'tool'): string {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (!r || !Array.isArray(r.content)) {
    const raw = JSON.stringify(result);
    return r && r.isError ? `MCP tool error (${toolName}): ${raw}` : raw;
  }
  const text = r.content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type ?? 'non-text'} content]`))
    .join('\n');
  const body = text || (r.isError ? '(empty error result)' : '(empty result)');
  return r.isError ? `MCP tool error (${toolName}): ${body}` : body;
}
