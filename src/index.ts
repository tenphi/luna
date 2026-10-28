/**
 * Luna — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import { CENTRAL_DB_PATH } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { initDb } from './db/connection.js';
import { initializeCentralSchema } from './db/initialize.js';
import { resetAllContainerStatus } from './db/sessions.js';
import { ensureContainerRuntimeRunning, cleanupOrphans, refreshContainerHostGateway } from './container-runtime.js';
import { stopAllContainers } from './container-runner.js';
import { drainInboundRouting } from './inbound-inflight.js';
import { startOneCliBridge, stopOneCliBridge } from './onecli-bridge.js';
import { startProviderBridges, stopProviderBridges } from './provider-bridge.js';
import { ensureOneCliRuntime, shouldManageLocalOneCli } from './onecli-runtime.js';
import { setDeliveryAdapter } from './delivery.js';
import { setProgressSinkFactory } from './progress/status-events.js';
import { installProgressPersistence, reconcileOrphanedProgressBubbles } from './progress/persistence.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { runSessionGc } from './session-gc.js';
import { bootstrapSingleAgent } from './bootstrap.js';
import { ensureHotMemoryPages } from './users/hot-memory.js';
import { log } from './log.js';
import { closeEmailBackend } from './host-mcp/builtins/email/provider.js';
import { closeMemory } from './memory/client.js';
import { markHostBoot } from './host-boot.js';

import {
  registerResponseHandler,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

// Channel barrel — each enabled channel self-registers on import.
import './channels/index.js';

// Load the installed host module registrations.
import './modules/index.js';

// CLI command barrel — populates the `luna` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';
import { startHostMcpSupervisor, stopHostMcpSupervisor } from './host-mcp-supervisor.js';

import { createChannelDeliveryBridge, channelSetup } from './channels/host-events.js';
import { initChannelAdapters, teardownChannelAdapters } from './channels/channel-registry.js';

async function main(): Promise<void> {
  // Scope health/`luna status` error tails to this process (see host-boot.ts).
  markHostBoot();
  log.info('Luna starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = CENTRAL_DB_PATH;
  const db = initDb(dbPath);
  initializeCentralSchema(db);
  bootstrapSingleAgent();
  log.info('Central DB ready', { path: dbPath });

  // 2. Container runtime. cleanupOrphans kills agent containers left by a
  // previous run, so no session can still have one — clear the persisted
  // mirror, which a crashed host would otherwise leave reading 'running'.
  ensureContainerRuntimeRunning();
  cleanupOrphans();
  const staleContainerRows = resetAllContainerStatus();
  if (staleContainerRows > 0) {
    log.info('Reset stale container status', { sessions: staleContainerRows });
  }

  // 2a. Local OneCLI gateway (Apple Container postgres + vault image)
  if (shouldManageLocalOneCli()) {
    try {
      await ensureOneCliRuntime();
    } catch (err) {
      log.error('OneCLI gateway ensure failed — credential injection may be unavailable', { err });
    }
  }

  // container-runtime.ts is imported before main(), when a cold-booted Apple
  // Container has no network to inspect yet. Re-detect only after the
  // install-scoped OneCLI network has been created; agent Session API URLs and
  // host bridges must use that network's gateway rather than the boot-time
  // 0.0.0.0 fallback (or the default network's different subnet).
  refreshContainerHostGateway();

  // 2b. OneCLI bridge — forwards <gateway>:10255 → 127.0.0.1:10255 so agent
  // containers can reach the loopback-only OneCLI proxy.
  onShutdown(() => stopOneCliBridge());
  startOneCliBridge();

  // 2c. Provider bridge — forwards <gateway>:<port> → 127.0.0.1:<port> for every
  // provider baseUrl pointing at the host bridge, so agent containers can reach
  // a local inference server that binds loopback only. No-op for remote
  // providers.
  onShutdown(() => stopProviderBridges());
  startProviderBridges();

  // 3. Delivery adapter bridge — dispatches to channel adapters.
  //
  // Registered before the adapters exist on purpose: it resolves the adapter
  // per call, and both the Session API and the sweep need a delivery target
  // the moment they start. Delivering into a channel that hasn't finished
  // initialising throws, which is the correct retryable failure.
  const deliveryAdapter = createChannelDeliveryBridge();
  setDeliveryAdapter(deliveryAdapter);

  // 3a. Progress sink factory — builds per-session channel sinks for the
  // live thinking/status message (Telegram edit path + CLI push path).
  installProgressPersistence();
  const { notifyCliStatus } = await import('./channels/cli.js');
  setProgressSinkFactory((channelType, platformId, threadId) => {
    if (channelType === 'agent') return null;

    if (channelType === 'cli') {
      return {
        isCli: true,
        async sendStatus(_text) {
          return undefined;
        },
        async editStatus(_id, _text) {},
        pushCliStatus: (lines) => notifyCliStatus(lines),
      };
    }

    // All other channels (Telegram, etc.) — use deliveryAdapter.deliver for
    // the initial send (returns platform message id) and operation:'edit' for
    // subsequent edits.
    //
    // `plain: true` keeps status bubbles on the regular (non-rich) message
    // path: single newlines stay line breaks, and Telegram uses normal chat
    // typography instead of Rich Message document sizing.
    //
    // `silent: true` sends it without a notification sound (Telegram's "Send
    // Without Sound"): the bubble is progress the user watches while waiting,
    // and the answer that follows is the thing worth a ping. Edits never
    // notify, so only the first send carries it.
    //
    // Telegram live drafts would suppress the banner too, but they are the
    // wrong shape for a bubble: the client fade-in animates *character
    // additions*, and a bubble that rewrites itself every second ("Thinking…
    // 3s" → "Reading a file · 5s") re-animates from the start each time, so
    // the chat jumps. Drafts fit append-only text — see telegram-draft.ts.
    return {
      isCli: false,
      async sendStatus(text: string): Promise<string | undefined> {
        return deliveryAdapter.deliver(
          channelType,
          platformId,
          threadId,
          'chat',
          JSON.stringify({ text, plain: true, silent: true }),
        );
      },
      async editStatus(messageId: string, text: string): Promise<void> {
        await deliveryAdapter.deliver(
          channelType,
          platformId,
          threadId,
          'chat',
          JSON.stringify({ operation: 'edit', messageId, text, plain: true, silent: true }),
        );
      },
      async deleteStatus(messageId: string): Promise<void> {
        await deliveryAdapter.deliver(
          channelType,
          platformId,
          threadId,
          'chat',
          JSON.stringify({ operation: 'delete', messageId }),
        );
      },
      // Live reply preview. `operation: 'stream'` is a channel-level hint, not
      // a message: a channel that can show growing text quietly renders it
      // (Telegram uses a live draft), and one that can't throws, which tells
      // the caller to stop for this turn.
      async streamReply(streamId: number, text: string): Promise<void> {
        await deliveryAdapter.deliver(
          channelType,
          platformId,
          threadId,
          'chat',
          JSON.stringify({ operation: 'stream', streamId, text }),
        );
      },
    };
  });

  // 4. Host MCP bridge + Session API (Apple/email builtins, install-local
  // stdio servers, and the container's only route to its session.db).
  //
  // Must be listening before anything can spawn a container. A container that
  // starts against a closed :18800 spends its first seconds retrying RPCs it
  // has no reason to retry, and the very first inbound message of a host's
  // life is exactly when that window used to be open.
  onShutdown(() => stopHostMcpSupervisor());
  await startHostMcpSupervisor();

  // Every configured person gets a page to have standing notes on. Not awaited: memory may be slow to
  // come up or absent entirely, and a missing page costs a turn of context rather than correctness —
  // it must not hold up the first inbound message.
  void ensureHotMemoryPages().catch((err) => log.warn('Hot-memory scaffolding failed', { err }));

  // 5. Channel adapters — the first thing that accepts outside work, so it
  // goes last of the message-path components.
  await initChannelAdapters(channelSetup);

  // 5a. Close progress bubbles a previous run left ticking. Needs the channel
  // adapters, since closing one means editing a real platform message.
  reconcileOrphanedProgressBubbles().catch((err) => log.warn('Progress bubble reconciliation failed', { err }));

  // 6. Start the host sweep — stuck-message recovery, wake, recurrence, and
  // the outbound delivery backstop, in that order. Delivery is otherwise eager
  // via the Session API.
  startHostSweep();
  log.info('Host sweep started');

  // 7. Session GC — reclaim expired ephemeral sessions + orphan session dirs.
  // Runs once now (catches db-reset leftovers) and hourly thereafter.
  const SESSION_GC_INTERVAL_MS = 60 * 60 * 1000;
  const runGc = () => {
    try {
      runSessionGc();
    } catch (err) {
      log.warn('Session GC pass failed', { err });
    }
  };
  runGc();
  const sessionGcTimer = setInterval(runGc, SESSION_GC_INTERVAL_MS);
  sessionGcTimer.unref();
  onShutdown(() => clearInterval(sessionGcTimer));

  // 8. Memory needs nothing started. It is its own launchd service, owning the index, the file
  // watcher, its models and the nightly maintenance cycle; Luna holds one socket connection to it,
  // opened on first use and closed here. What this replaces: a maintenance scheduler with four
  // modes, a launchd autopilot with a drift check, a Postgres forwarder, and model-config sync in
  // three directions.
  onShutdown(() => closeMemory());

  // Mail holds one IMAP connection per mailbox, kept warm so a run of questions about mail does not
  // pay a TLS handshake each time. Closing them here is what makes Gmail see a logout rather than a
  // dropped socket it has to time out.
  onShutdown(() => closeEmailBackend());

  // 9. Start the `luna` CLI socket server (data/luna.sock).
  await startCliServer();

  log.info('Luna running');
}

/** Longest we'll wait for messages mid-route to reach their session.db. */
const INBOUND_DRAIN_MS = 5_000;
/** Longest we'll wait for agent containers to exit on their own. */
const CONTAINER_STOP_MS = 10_000;

let shuttingDown = false;

/**
 * Graceful shutdown.
 *
 * Ordered by what loses data: stop producing new work, let work already in
 * flight land, then tear down the services that work depends on. Killing the
 * containers before the shutdown callbacks matters — the callbacks stop the
 * host MCP bridge, and with it the Session API the containers are writing
 * their last replies through.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    log.warn('Shutdown already in progress', { signal });
    return;
  }
  shuttingDown = true;
  log.info('Shutdown signal received', { signal });

  // 1. Stop the sweep first, or it spends the next 60s waking containers we
  //    are in the middle of killing.
  stopHostSweep();

  // 2. Messages being routed right now exist nowhere but memory.
  const stranded = await drainInboundRouting(INBOUND_DRAIN_MS);
  if (stranded > 0) {
    log.error('Gave up on inbound messages still being routed', { stranded });
  }

  // 3. Containers, while the Session API is still answering them.
  await stopAllContainers('host-shutdown', CONTAINER_STOP_MS);

  // 4. Module-registered teardown (host MCP bridge, OneCLI bridge, the memory connection,
  //    timers).
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }

  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
