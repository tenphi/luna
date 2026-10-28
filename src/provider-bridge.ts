/**
 * Local model provider bridge forwarder.
 *
 * Local inference servers (llama-host, llama.cpp, Ollama, LM Studio) commonly
 * bind 127.0.0.1 only. Agent containers cannot reach the host's loopback — an
 * Apple Container VM sees the host at the bridge gateway (CONTAINER_HOST_GATEWAY,
 * e.g. 192.168.64.1) — so a `providers.*.baseUrl` naming the host fails to
 * connect even though the endpoint answers fine on the host.
 *
 * All three spellings of "the host" get a forwarder: plain loopback (the natural
 * thing to write, and what `containerReachableUrl` rewrites on the way into a
 * container), the `host.docker.internal` alias, and the gateway IP itself.
 *
 * Rather than make the user re-bind their inference server to all interfaces —
 * which puts local models on the LAN — Luna runs the same tiny in-process TCP
 * forwarder used by `onecli-bridge.ts`, one per
 * distinct provider port.
 *
 * Like the Postgres bridge (and unlike the OneCLI one) this binds the gateway IP
 * specifically: the inference server already holds 127.0.0.1:<port>, so a
 * 0.0.0.0 bind would collide (EADDRINUSE) — and binding the gateway keeps the
 * models off every other interface.
 */
import net from 'net';

import { loadLunaConfig, resolveSecretOrValue } from './config/loader.js';
import { CONTAINER_HOST_ALIAS, CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { log } from './log.js';

const LOOPBACK = '127.0.0.1';

/** Hostnames that always mean "the host machine" in a provider baseUrl. */
const HOST_ALIASES = new Set([CONTAINER_HOST_ALIAS, LOOPBACK, 'localhost', '::1', '[::1]']);

function isHostAlias(hostname: string): boolean {
  // CONTAINER_HOST_GATEWAY is refreshed after the Apple Container network
  // starts, so read its live ESM binding instead of capturing the boot-time
  // fallback in HOST_ALIASES.
  return hostname === CONTAINER_HOST_GATEWAY || HOST_ALIASES.has(hostname);
}

const servers = new Map<number, net.Server>();

/**
 * Ports to bridge: every configured provider baseUrl that targets this machine.
 * Providers on a genuinely remote host (or on a hostname containers already
 * resolve) are left alone.
 */
export function resolveProviderBridgePorts(cfg = loadLunaConfig()): number[] {
  const ports = new Set<number>();

  for (const entry of Object.values(cfg.providers ?? {})) {
    const baseUrl = resolveSecretOrValue(entry?.baseUrl ?? undefined);
    if (!baseUrl) continue;
    try {
      const parsed = new URL(baseUrl);
      if (!isHostAlias(parsed.hostname)) continue;
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      if (Number.isFinite(port) && port > 0) ports.add(port);
    } catch {
      // Unparseable baseUrl — the provider itself will surface that.
    }
  }

  return [...ports];
}

function startOne(port: number): void {
  const srv = net.createServer((client) => {
    const upstream = net.connect(port, LOOPBACK);

    const cleanup = (): void => {
      client.destroy();
      upstream.destroy();
    };

    client.on('error', cleanup);
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNREFUSED') {
        log.debug('Provider bridge upstream error', { port, err: err.message });
      }
      cleanup();
    });

    client.pipe(upstream);
    upstream.pipe(client);
  });

  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.warn('Provider bridge address already in use — the provider likely binds the bridge directly', {
        listen: `${CONTAINER_HOST_GATEWAY}:${port}`,
      });
    } else if (err.code === 'EADDRNOTAVAIL') {
      log.warn('Provider bridge cannot bind gateway — Apple Container bridge not up yet', {
        listen: `${CONTAINER_HOST_GATEWAY}:${port}`,
      });
    } else {
      log.error('Provider bridge server error', { port, err });
    }
    servers.delete(port);
  });

  srv.listen(port, CONTAINER_HOST_GATEWAY, () => {
    log.info('Provider bridge forwarder started', {
      listen: `${CONTAINER_HOST_GATEWAY}:${port}`,
      upstream: `${LOOPBACK}:${port}`,
    });
  });

  servers.set(port, srv);
}

/**
 * Start a forwarder per host-bridge provider port. No-op when every provider is
 * remote. Safe to call before the inference server is up.
 */
export function startProviderBridges(): void {
  for (const port of resolveProviderBridgePorts()) {
    if (servers.has(port)) continue;
    startOne(port);
  }
}

/** Stop all provider bridge forwarders. */
export function stopProviderBridges(): void {
  for (const srv of servers.values()) {
    srv.close();
  }
  servers.clear();
}
