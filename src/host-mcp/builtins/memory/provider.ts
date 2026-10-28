/**
 * The memory builtin: Akno, running as its own service on this Mac, exposed to agent
 * containers as `memory` through the host MCP bridge that already carries the Apple apps.
 *
 * Nothing is spawned or supervised here. Akno installs its own launchd agent
 * (`akno service install`) and owns the index, the file watcher, the model connections and the
 * nightly maintenance cycle. Luna's whole relationship with memory is: is the door answering,
 * and what does it say. That is the difference between this file and the four thousand lines of
 * host-side memory glue it replaces — a maintenance scheduler, an autopilot drift check, a
 * Postgres forwarder, model-config sync in three directions, and a reconciler for a facts table
 * that drifted from the Markdown it was derived from.
 *
 * The one health check worth making at boot is whether the door answers, because the failure it
 * catches is silent: with two Aknos pointed at one knowledge base the second is read-only, so
 * recall works, every tool is present, and the first `remember` of the day fails.
 */
import os from 'os';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { loadLunaConfig } from '../../../config/loader.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import { memoryReachable, memorySocketPath } from '../../../memory/client.js';
import { readMemoryHealth, type MemoryServiceHealth } from '../../../memory/health.js';
import type { BuiltinMcpProvider, BuiltinServerInfo } from '../types.js';
import { createMemoryMcpServer } from './servers/memory.js';

export const MEMORY_SERVER_KEY = 'memory';

function envKillSwitch(): boolean {
  const fromProcess = process.env.LUNA_MEMORY_ENABLED;
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess === 'false';
  return readEnvFile(['LUNA_MEMORY_ENABLED']).LUNA_MEMORY_ENABLED === 'false';
}

export function isMemoryBuiltinEnabled(): boolean {
  if (os.platform() !== 'darwin') return false;
  if (envKillSwitch()) return false;
  return loadLunaConfig().memory?.enabled !== false;
}

export const memoryProvider: BuiltinMcpProvider = {
  id: 'memory',

  isEnabled: isMemoryBuiltinEnabled,

  listServers(): BuiltinServerInfo[] {
    if (!isMemoryBuiltinEnabled()) return [];
    return [{ name: MEMORY_SERVER_KEY, oneCli: false }];
  },

  async prepare() {
    const factories: Record<string, () => McpServer> = {};

    // Reported, never fatal. A Mac that has not installed the memory service yet should still
    // get an agent that talks, and the tools say plainly that memory is unreachable rather than
    // that it is empty — the distinction the agent needs in order not to claim you never
    // mentioned something.
    const health = await memoryReachable();
    if (!health.ok) {
      log.warn(`[memory] ${health.detail} — start it with \`akno service install\`, or set memory.enabled=false`);
    } else if (!health.writable) {
      log.warn(`[memory] ${health.detail} — remember and write will fail until only one Akno runs`);
    } else {
      log.info(`[memory] ${health.detail}`);
    }

    factories[MEMORY_SERVER_KEY] = () => createMemoryMcpServer();
    return { factories };
  },
};

/** Owner-requested health includes Akno's maintenance state; startup remains a connection check. */
export async function memoryHealth(): Promise<MemoryServiceHealth> {
  if (!isMemoryBuiltinEnabled()) {
    return {
      ok: false,
      writable: false,
      detail: 'disabled (memory.enabled=false)',
      maintenance: { status: 'skipped', state: 'disabled', detail: 'Memory is disabled.' },
    };
  }
  return readMemoryHealth();
}

export { memorySocketPath };
