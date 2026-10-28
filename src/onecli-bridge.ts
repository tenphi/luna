/**
 * OneCLI bridge forwarder.
 *
 * OneCLI's gateway proxy binds 127.0.0.1:10255 only. Apple Container VMs cannot
 * reach the host's loopback — they only see the bridge gateway (192.168.64.1).
 *
 * Luna runs a tiny in-process TCP forwarder that listens on all interfaces and
 * pipes to the loopback proxy. Agent containers reach it at
 * <CONTAINER_HOST_GATEWAY>:ONECLI_BRIDGE_PORT with zero host configuration.
 */
import net from 'net';

import { log } from './log.js';

/** Port OneCLI's gateway proxy listens on (loopback). */
export const ONECLI_BRIDGE_PORT = 10255;

/** Loopback address OneCLI binds. */
const ONECLI_LOOPBACK = '127.0.0.1';

let server: net.Server | null = null;

/** Start the OneCLI bridge forwarder. Safe to call when OneCLI isn't running. */
export function startOneCliBridge(): void {
  if (server) return;

  const srv = net.createServer((client) => {
    const upstream = net.connect(ONECLI_BRIDGE_PORT, ONECLI_LOOPBACK);

    const cleanup = (): void => {
      client.destroy();
      upstream.destroy();
    };

    client.on('error', cleanup);
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNREFUSED') {
        log.debug('OneCLI bridge upstream error', { err: err.message });
      }
      cleanup();
    });

    client.pipe(upstream);
    upstream.pipe(client);
  });

  srv.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.warn('OneCLI bridge port already in use — assuming an external forwarder is present', {
        port: ONECLI_BRIDGE_PORT,
      });
    } else {
      log.error('OneCLI bridge server error', { err });
    }
  });

  srv.listen(ONECLI_BRIDGE_PORT, '0.0.0.0', () => {
    log.info('OneCLI bridge forwarder started', {
      listen: `0.0.0.0:${ONECLI_BRIDGE_PORT}`,
      upstream: `${ONECLI_LOOPBACK}:${ONECLI_BRIDGE_PORT}`,
    });
  });

  server = srv;
}

/** Stop the OneCLI bridge forwarder. */
export function stopOneCliBridge(): void {
  if (!server) return;
  server.close();
  server = null;
}
