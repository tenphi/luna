/**
 * Container runtime abstraction for Luna.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { getInstallSlug } from './install-slug.js';
import { log } from './log.js';

/** The container runtime binary name (Apple Container on macOS). */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 *
 * This is a live binding rather than a constant because the module is imported
 * before startup brings up Apple Container and the install-scoped network. On a
 * cold boot the first detection can therefore be the 0.0.0.0 fallback. Startup
 * refreshes it after the network exists, before any bridge or agent container
 * consumes it.
 */
export let CONTAINER_HOST_GATEWAY = detectHostGateway();

/** User-facing hostname alias rewritten to CONTAINER_HOST_GATEWAY at spawn. */
export const CONTAINER_HOST_ALIAS = 'host.docker.internal';

/** Hostnames that mean "this Mac" when they appear in a host-side config value. */
const HOST_LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Rewrite a host-side URL so an agent container can reach the same service.
 *
 * Config is written from the host's point of view — `http://127.0.0.1:8080/v1`
 * is what the user types, what `curl` on the Mac uses, and what host-side health
 * probes hit. Neither form survives the trip into an Apple Container: loopback
 * there is the container itself, and `host.docker.internal` does not resolve at
 * all. Both become the bridge gateway. A LAN or cloud address is already
 * reachable and passes through untouched.
 *
 * The loopback case only works because `provider-bridge.ts` puts a forwarder on
 * <gateway>:<port> for exactly these ports — a server bound to loopback alone
 * would otherwise not answer there.
 */
export function containerReachableUrl<T extends string | undefined>(url: T): T {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL — the consumer will surface that in its own terms.
    return url;
  }
  if (parsed.hostname !== CONTAINER_HOST_ALIAS && !HOST_LOOPBACK_HOSTNAMES.has(parsed.hostname)) return url;

  parsed.hostname = CONTAINER_HOST_GATEWAY;
  const rewritten = parsed.toString();
  // URL.toString() appends "/" to an empty path; keep the caller's exact shape
  // so a baseUrl the SDK concatenates onto does not grow a double slash.
  return (rewritten.endsWith('/') && !url.endsWith('/') ? rewritten.slice(0, -1) : rewritten) as T;
}

function detectHostGateway(): string {
  // Ask the runtime, then the host's own bridge. Every step below reads the
  // address off this machine — nothing here is a baked-in subnet, because the
  // bridge address is assigned per host and per creation order, not fixed.
  if (CONTAINER_RUNTIME_BIN === 'container' && os.platform() === 'darwin') {
    // Apple Container hands each network the next free subnet in creation
    // order, so the install-scoped network is NOT reliably 192.168.64.0/24 —
    // the builtin `default` network takes whichever subnet is free first, and
    // after `default` claims .64 an install network created later lands on
    // .65 with gateway 192.168.65.1. Guessing .64.1 there leaves agent
    // containers unable to reach the Session API at all (they exit code 1)
    // and makes provider-bridge bind an address the bridge does not carry.
    const fromRuntime =
      inspectNetworkGateway(`luna-onecli-net-${getInstallSlug()}`) ?? inspectNetworkGateway('default');
    if (fromRuntime) return fromRuntime;
  }
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // No runtime answer and no bridge interface: there is no container network on
  // this host yet, so there is no gateway to name. 0.0.0.0 is the honest stand-in
  // for "every interface" — it keeps the host-side forwarders in provider-bridge
  // and onecli-bridge bindable (the latter already listens there by choice)
  // instead of throwing EADDRNOTAVAIL on an address this machine does not own.
  // It is deliberately NOT a usable destination from inside a container; with no
  // container network there is also no container that could dial it.
  return '0.0.0.0';
}

/** Re-detect the gateway after startup has brought up the container network. */
export function refreshContainerHostGateway(): string {
  const previous = CONTAINER_HOST_GATEWAY;
  const detected = detectHostGateway();
  CONTAINER_HOST_GATEWAY = detected;
  if (detected !== previous) {
    log.info('Container host gateway refreshed', { previous, gateway: detected });
  }
  return detected;
}

/**
 * IPv4 gateway of one container network, or null when the network is absent or
 * the runtime is not answering. Called before any container work, so a missing
 * network is an ordinary answer rather than a fault.
 */
function inspectNetworkGateway(name: string): string | null {
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} network inspect ${name}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out || '[]') as Array<{ status?: { ipv4Gateway?: string } }>;
    return parsed[0]?.status?.ipv4Gateway ?? null;
  } catch {
    return null;
  }
}

/** CLI args so containers can reach host services (OneCLI, Apple, local LLMs). */
export function hostGatewayArgs(): string[] {
  return [];
}

/** Replace the host alias in container -e values with the bridge gateway IP. */
export function rewriteContainerHostAliasInArgs(args: string[]): void {
  const gateway = CONTAINER_HOST_GATEWAY;
  const alias = CONTAINER_HOST_ALIAS;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    if (args[i + 1].includes(alias)) {
      args[i + 1] = args[i + 1].replaceAll(alias, gateway);
    }
  }
}

/** Rewrite persisted MCP env URLs for Apple Container (container.json / DB-backed config). */
export function rewriteContainerHostAliasInEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return env;
  const gateway = CONTAINER_HOST_GATEWAY;
  const alias = CONTAINER_HOST_ALIAS;
  let changed = false;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value.includes(alias)) {
      out[key] = value.replaceAll(alias, gateway);
      changed = true;
    } else {
      out[key] = value;
    }
  }
  return changed ? out : env;
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/**
 * How long to wait for `container stop` before giving up on it.
 *
 * This call is synchronous, so a runtime that wedges here wedges the entire
 * host process — the sweep can't run, messages can't be delivered, nothing.
 * Callers treat the throw as "graceful stop failed" and fall back to SIGKILL.
 */
export const STOP_CONTAINER_TIMEOUT_MS = 15_000;

/** Stop a container by name. Throws if the runtime doesn't comply in time. */
export function stopContainer(name: string, timeoutMs: number = STOP_CONTAINER_TIMEOUT_MS): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe', timeout: timeoutMs });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    log.debug('Container runtime already running');
  } catch {
    // A non-zero status is how `system status` reports "not running", which is the case this
    // function exists for. The error says nothing the next line does not.
    log.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      log.info('Container runtime started');
    } catch (startErr) {
      log.error('Failed to start container runtime', { err: startErr });
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Container runtime failed to start                      ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:              ║');
      console.error('║  1. Install from https://github.com/apple/container/releases   ║');
      console.error('║  2. Run: container system start                                ║');
      console.error('║  3. Restart Luna                                                 ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Container runtime is required but failed to start', { cause: startErr });
    }
  }
}

// Agent containers are always named `luna-agent-<timestamp>` (see
// `spawnContainer` in container-runner.ts). Match that specific prefix — NOT a
// bare `luna-` — so the OneCLI gateway/postgres infra containers
// (`luna-onecli-*`), which are managed separately and meant to persist, are
// never swept up by orphan cleanup or a deploy's stop-agents step.
const LUNA_CONTAINER_PREFIX = 'luna-agent-' as const;

function isLunaContainerId(id: string): boolean {
  return id.startsWith(LUNA_CONTAINER_PREFIX);
}

/**
 * List running Luna agent container names for this install.
 *
 * Apple Container has no label filter on `ls`; we match the `luna-agent-` name
 * prefix and, when present, the install label stamped at spawn time.
 */
export function listRunningAgentContainerNames(): string[] {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: {
      status: string;
      configuration: { id: string; labels?: Record<string, string> };
    }[] = JSON.parse(output || '[]');
    const slug = CONTAINER_INSTALL_LABEL.split('=')[1];
    return containers
      .filter((c) => {
        if (c.status !== 'running' || !isLunaContainerId(c.configuration.id)) return false;
        const labels = c.configuration.labels;
        if (labels && slug) {
          const install = labels['luna-install'] ?? labels['com.luna.install'];
          if (install && install !== slug) return false;
        }
        return true;
      })
      .map((c) => c.configuration.id);
  } catch (err) {
    log.warn('Failed to list running Luna containers', { err });
    return [];
  }
}

/** Stop all running Luna agent containers for this install. Returns names stopped. */
export function stopRunningAgentContainers(reason: string): string[] {
  const names = listRunningAgentContainerNames();
  const stopped: string[] = [];
  for (const name of names) {
    try {
      stopContainer(name);
      stopped.push(name);
    } catch {
      /* already stopped */
    }
  }
  if (stopped.length > 0) {
    log.info('Stopped running agent containers', { reason, count: stopped.length, names: stopped });
  }
  return stopped;
}

/**
 * Kill orphaned Luna agent containers from THIS install's previous runs.
 *
 * Apple Container has no label filter on `ls`; we match the `luna-agent-` name
 * prefix and, when present, the install label stamped at spawn time. OneCLI
 * gateway/postgres infra containers are intentionally excluded.
 */
export function cleanupOrphans(): void {
  const orphans = listRunningAgentContainerNames();
  for (const name of orphans) {
    try {
      stopContainer(name);
    } catch {
      /* already stopped */
    }
  }
  if (orphans.length > 0) {
    log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
  }
}
