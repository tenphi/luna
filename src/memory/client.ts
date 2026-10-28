/**
 * The one place Luna talks to memory.
 *
 * Memory is Akno: a service on this Mac that owns a Markdown knowledge base, its index, its
 * models and its maintenance. Luna does not index, chunk, embed, extract, OCR, derive facts,
 * resolve slugs, or reconcile anything — it asks. Everything that used to be Luna's memory
 * implementation is now somebody else's problem, on purpose.
 *
 * `@tenphi/akno-client` is that ask, typed from the same op registry the service dispatches on, so a
 * call that compiles is a call the service accepts. It is pinned to a released Akno version. Folder
 * timelines require 0.14.0 or later; the client refuses scoped calls when the service lacks them.
 *
 * The unix socket is the door: no port to bind, no address to configure, and filesystem
 * permissions are the authentication — the Luna host and the memory service run as the same user
 * on the same Mac. Containers never reach it, which is the point. Memory tools are a host MCP
 * builtin, so every call is made by this process, and the knowledge base never enters a sandbox.
 */
import { connect, defaultSocketPath, type AknoClient } from '@tenphi/akno-client';

import { loadLunaConfig } from '../config/loader.js';
import { log } from '../log.js';

export class MemoryUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryUnavailable';
  }
}

/** Where the service listens. Unset means Akno's own default, which is the normal case. */
export function memorySocketPath(): string {
  const fromEnv = process.env.AKNO_SOCKET;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return loadLunaConfig().memory?.socket ?? defaultSocketPath();
}

let client: AknoClient | null = null;
let connecting: Promise<AknoClient> | null = null;
let warnedUnavailable = false;

/**
 * One connection for the life of the process, re-established after a drop.
 *
 * A connection per call would cost a socket handshake on every message, and the reason to run
 * memory as a service at all is that a warm handle answers in microseconds where a cold process
 * costs 33 ms. Concurrent first calls share one attempt rather than racing to open several.
 */
async function handle(): Promise<AknoClient> {
  // A test must never reach the real knowledge base.
  //
  // Not paranoia: a CLI test that mocks only the *config* paths can still reach the live service,
  // because `luna config users set` scaffolds a hot-memory page — and the run then writes real pages
  // into the operator's knowledge base. Nothing fails, so nothing says so. A unit test reaching a
  // live service over a socket in `$HOME` is a mistake that any file
  // can make by importing the wrong thing, so the refusal belongs at the socket rather than in each
  // test's mock list.
  //
  // `MemoryUnavailable` rather than a bespoke error because every caller already degrades on it: the
  // path under test proceeds exactly as it does on a machine with no memory service. A test that
  // genuinely wants the real thing sets `LUNA_ALLOW_REAL_MEMORY=1` and says why.
  if (process.env.VITEST && process.env.LUNA_ALLOW_REAL_MEMORY !== '1') {
    throw new MemoryUnavailable(
      'refusing to reach the memory service from a test — mock src/memory/client.js, or set LUNA_ALLOW_REAL_MEMORY=1',
    );
  }

  if (client) return client;
  if (connecting) return connecting;

  const socket = memorySocketPath();
  // Five minutes, against the client's 30-second default. One op is not one model call: a
  // `remember` and `retain` can run extraction, routing, and conflict checks, while `ingest` can be
  // OCR over a long scan followed by a naming call. A retain timeout is uncertain: its caller
  // keeps the source revision and reconciles the receipt after the server finishes.
  connecting = connect({ socket, timeoutMs: 300_000 })
    .then((connected) => {
      client = connected;
      connecting = null;
      warnedUnavailable = false;
      log.info(
        `memory connected: ${socket} (Akno ${connected.hello.version}, protocol ${connected.hello.protocol}, ` +
          `${connected.hello.ops.length} ops)`,
      );
      if (!connected.hello.writable) {
        // Reads work, every write fails. Worth a line at connect time rather than a puzzling
        // failure on the first thing the user asks to be remembered.
        log.warn('memory is read-only — another process holds the write handle; remember and write will fail');
      }
      return connected;
    })
    .catch((err: unknown) => {
      connecting = null;
      const reason = err instanceof Error ? err.message : String(err);
      // Once per outage, not once per turn: a service that is down produces one attempt per
      // message, and the log is where someone looks to find out why answers got worse.
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        log.warn(`memory unreachable at ${socket}: ${reason}`);
      }
      throw new MemoryUnavailable(`no memory service at ${socket}: ${reason}`);
    });

  return connecting;
}

/**
 * The client, for callers that want the typed ops directly.
 *
 * Throws `MemoryUnavailable` when the *service* cannot be reached. An op that ran and refused —
 * a conflict, a gated proposal, a page that does not exist — comes back as a result with a status,
 * because those are answers and callers have to be able to tell them apart from an outage.
 */
export async function memory(): Promise<AknoClient> {
  try {
    return await handle();
  } catch (err) {
    if (err instanceof MemoryUnavailable) throw err;
    throw new MemoryUnavailable(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Runs one call, dropping the cached connection if the socket died under it.
 *
 * **The dead handle is discarded; the call is not repeated.** A socket that dies mid-call says
 * nothing about whether the server finished the work — and it usually had. Re-running is
 * at-least-once delivery, which for `write`, `remember`, `approve` or `ingest` means doing the thing
 * twice. Observed exactly that: a service restarted underneath an `approve` and the held claim was
 * written into the page twice, one copy journalled and one not.
 *
 * So the next call reconnects (`memory()` rebuilds on a null handle) and this one fails honestly.
 * A retry that is safe belongs at the call site, where the caller knows whether repeating is
 * harmless — `retryRead` below is that, for the reads where it is.
 */
export async function withMemory<T>(work: (client: AknoClient) => Promise<T>): Promise<T> {
  const handle = await memory();
  try {
    return await work(handle);
  } catch (err) {
    if (!isMemoryConnectionLoss(err)) throw err;

    // Cleared so the next call reconnects instead of failing forever on a dead socket.
    await handle.close().catch(() => {});
    client = null;

    // Nothing was sent, so repeating is not repeating the work — the client refused before
    // writing to a socket it already knew was closed. This is the ordinary case after the memory
    // service restarts, and it must not cost the caller its input: every write went through here,
    // and the digest deletes its queue before calling, so one restart silently lost a message.
    if (wasRefusedBeforeSending(err)) {
      log.warn('memory connection was already closed — reconnecting and retrying, nothing had been sent');
      return work(await memory());
    }

    log.warn('memory connection dropped mid-call — the next call will reconnect');
    throw err;
  }
}

/**
 * Reconcile a mutation whose exact request has an Akno replay receipt. The key must be supplied
 * by the caller and preserved in `work`; operations without a receipt must use `withMemory`.
 * A lost socket can follow a successful commit, so only Akno's stored receipt may settle it.
 */
export async function withReceiptMemory<T>(
  idempotencyKey: string,
  work: (client: AknoClient) => Promise<T>,
): Promise<T> {
  if (!idempotencyKey) throw new Error('a replay-safe mutation requires an idempotency key');
  try {
    return await withMemory(work);
  } catch (err) {
    if (!isMemoryConnectionLoss(err)) throw err;
    log.warn('memory reply lost after a receipt-backed mutation — reconciling the same key');
    return withMemory(work);
  }
}

/**
 * `withMemory`, plus one retry — for reads only.
 *
 * Repeating a `recall` costs a search. Repeating a write costs a duplicate, which is why this is a
 * separate function that a caller has to reach for rather than the default everything gets.
 */
export async function retryRead<T>(work: (client: AknoClient) => Promise<T>): Promise<T> {
  try {
    return await withMemory(work);
  } catch (err) {
    if (!isMemoryConnectionLoss(err)) throw err;
    return withMemory(work);
  }
}

/**
 * The socket is gone, whichever way it went.
 *
 * The two the client itself raises are the ones that matter, and neither was matched: after the
 * memory service restarted, every host call failed with "the connection is closed" — and because
 * that did not read as connection loss, the dead handle was never dropped and *every subsequent
 * call failed the same way* until the host process was restarted. Observed as two digests, ten
 * minutes apart, both lost.
 */
export function isMemoryConnectionLoss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /socket closed|EPIPE|ECONNRESET|not connected|closed before|connection is closed|closed the connection/i.test(
    err.message,
  );
}

/**
 * The call never left this process.
 *
 * The client checks a `closed` flag before writing anything, so this exact message means the
 * request was not sent — which makes retrying it safe even for a write, where the usual rule is
 * at-most-once. A connection that dies *mid*-call says nothing about whether the server finished,
 * and stays unsafe.
 */
function wasRefusedBeforeSending(err: unknown): boolean {
  return err instanceof Error && /the connection is closed/i.test(err.message);
}

/**
 * Whether the service is answering, for health output and for the builtin's boot check.
 *
 * Reports `writable` separately from `ok`, because the failure worth catching is the quiet one:
 * two Aknos pointed at one knowledge base leaves the second read-only, and everything looks
 * healthy right up to the first `remember`.
 */
export async function memoryReachable(): Promise<{ ok: boolean; writable: boolean; detail: string }> {
  const socket = memorySocketPath();
  try {
    const connected = await memory();
    const { hello } = connected;
    return {
      ok: true,
      writable: hello.writable,
      detail:
        `${hello.akno_path}, Akno ${hello.version}, protocol ${hello.protocol}, ${hello.ops.length} ops` +
        `${hello.writable ? '' : ' (READ-ONLY: another process holds the write handle)'}`,
    };
  } catch (err) {
    return {
      ok: false,
      writable: false,
      detail: `${socket} unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Closes the connection on shutdown, so the service sees a clean disconnect. */
export async function closeMemory(): Promise<void> {
  const open = client;
  client = null;
  if (open) await open.close().catch(() => {});
}
