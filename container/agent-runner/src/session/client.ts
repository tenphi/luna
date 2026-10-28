/**
 * SessionClient — the container's sole interface to session state.
 *
 * The container no longer opens SQLite files across the VirtioFS mount. All
 * session IO (inbound message polling, outbound message writes, per-provider
 * state, liveness) goes over HTTP to the host's Session API, which owns the
 * single per-session `session.db` on local disk. This eliminates the
 * cross-mount page-cache coherency errors (`disk I/O error`, `SQLITE_IOERR`,
 * "database disk image is malformed") that the old two-DB design fought with
 * retries and process respawns.
 *
 * Two implementations:
 *   - HttpSessionClient   — production; talks to the host bridge.
 *   - InMemorySessionClient — tests; a plain-JS model of the host store.
 */

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id?: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

export interface RoutingBySeq {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

/**
 * An ephemeral progress hint for the host's live status card.
 *
 * Deliberately not a `WriteMessageOut`: these are never persisted, never
 * retried, and worthless once stale, so they skip the durable outbound queue.
 */
export interface StatusEventOut {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  payload: Record<string, unknown>;
}

export interface TaskRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
}

export interface DestinationThread {
  threadId: string | null;
  inReplyTo: string | null;
}

export interface CliResponseRow {
  id: string;
  content: string;
}

export interface PingInfo {
  /** When true, update the in-flight-tool fields (tool may be null to clear). */
  setTool?: boolean;
  tool?: string | null;
  toolDeclaredTimeoutMs?: number | null;
  toolStartedAt?: string | null;
}

/** One completion's token usage, folded into the host's daily ledger. */
export interface UsageDelta {
  provider: string;
  model?: string | null;
  /** Current topic, so per-topic totals need no separate counter. '' when topics are off. */
  episodeId?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** False when the endpoint omitted `prompt_tokens_details` for this completion. */
  cachedTokensKnown?: boolean;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Prompt tokens of turns that reported cache details — the cache-rate denominator. */
  promptTokensCacheKnown: number;
  turns: number;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  session: UsageTotals;
  topic: UsageTotals | null;
  updatedAt: string | null;
}

export interface MemoryEditContext {
  id: string;
  file: string;
  diff: string;
  truncated: boolean;
}

export interface SessionClient {
  readMemoryEdits(): Promise<MemoryEditContext[]>;
  acknowledgeMemoryEdits(ids: string[]): Promise<void>;
  stageMemoryFile(document: string, id: string, filename?: string): Promise<{ filename: string } | { error: string }>;
  getPendingMessages(isFirstPoll: boolean): Promise<MessageInRow[]>;
  markProcessing(ids: string[]): Promise<void>;
  markCompleted(ids: string[]): Promise<void>;
  findQuestionResponse(questionId: string): Promise<MessageInRow | undefined>;

  writeMessageOut(msg: WriteMessageOut): Promise<number>;
  getMessageIdBySeq(seq: number): Promise<string | null>;
  getRoutingBySeq(seq: number): Promise<RoutingBySeq | null>;

  /** Ephemeral progress hint — applied to the host's status card, not stored. */
  writeStatus(ev: StatusEventOut): Promise<void>;

  getDestinations(): Promise<DestRow[]>;
  getSessionRouting(): Promise<SessionRouting>;
  resolveDestinationThread(channelType: string, platformId: string): Promise<DestinationThread | null>;
  listTasks(status?: string): Promise<TaskRow[]>;

  getSessionState(key: string): Promise<string | undefined>;
  setSessionState(key: string, value: string): Promise<void>;
  deleteSessionState(key: string): Promise<void>;

  /** Token accounting — host-owned daily ledger in the central DB. */
  recordUsage(delta: UsageDelta): Promise<void>;
  getUsageSummary(episodeId?: string | null): Promise<UsageSummary>;

  /** CLI transport helpers (in-container `luna`). */
  findCliResponse(requestId: string): Promise<CliResponseRow | null>;

  /** Liveness + in-flight-tool signalling (fire-and-forget on caller side). */
  ping(info?: PingInfo): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 100;

/**
 * Per-request ceiling.
 *
 * Without one, a wedged host holds the container forever: `fetch` has no
 * default timeout, so a connection that is accepted and never answered — a host
 * mid-restart, a hung handler — parks the poll loop indefinitely with no log
 * line and no recovery short of the host's 30-minute stuck-container kill.
 *
 * Generous because some handlers do real work in-request: `writeStatus` edits
 * the platform's status message before returning.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** An HTTP-level RPC failure, carrying whether another attempt could help. */
class RpcHttpError extends Error {
  constructor(
    method: string,
    readonly status: number,
  ) {
    super(`session-api ${method} → HTTP ${status}`);
    this.name = 'RpcHttpError';
  }

  /**
   * 401/403 mean the session token was rejected and 400/404 mean the call
   * itself is wrong — neither improves by asking again, so fail fast instead of
   * burning the whole retry budget on a certainty.
   */
  get retryable(): boolean {
    return this.status !== 400 && this.status !== 401 && this.status !== 403 && this.status !== 404;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, so concurrent RPCs don't retry in lockstep. */
function rpcBackoffMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return base + Math.random() * (base / 2);
}

export class HttpSessionClient implements SessionClient {
  private readonly rpcUrl: string;
  private readonly token: string;

  constructor(baseUrl?: string, token?: string) {
    const url = baseUrl ?? process.env.LUNA_SESSION_API_URL;
    const tok = token ?? process.env.LUNA_SESSION_TOKEN;
    if (!url) throw new Error('LUNA_SESSION_API_URL is not set');
    if (!tok) throw new Error('LUNA_SESSION_TOKEN is not set');
    this.rpcUrl = url.replace(/\/$/, '') + '/rpc';
    this.token = tok;
  }

  /**
   * One RPC, retried on transient failure.
   *
   * Retries here are deliberately short — about 1.5s total. They cover a
   * momentary blip, not a host restart; a longer outage is the poll loop's
   * problem to sit out, since retrying for minutes inside a single call would
   * just stall whatever turn is holding it.
   */
  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify({ method, params });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(this.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new RpcHttpError(method, res.status);
        const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
        if (!json.ok) throw new Error(json.error || `session-api ${method} failed`);
        return json.result as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof RpcHttpError && !err.retryable) break;
        if (attempt >= MAX_RETRIES) break;
        await sleep(rpcBackoffMs(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  readMemoryEdits(): Promise<MemoryEditContext[]> {
    return this.rpc<MemoryEditContext[]>('readMemoryEdits', {});
  }
  acknowledgeMemoryEdits(ids: string[]): Promise<void> {
    return ids.length ? this.rpc<void>('acknowledgeMemoryEdits', { ids }) : Promise.resolve();
  }
  getPendingMessages(isFirstPoll: boolean): Promise<MessageInRow[]> {
    return this.rpc<MessageInRow[]>('getPendingMessages', { isFirstPoll });
  }
  markProcessing(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.rpc<void>('markProcessing', { ids });
  }
  markCompleted(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.rpc<void>('markCompleted', { ids });
  }
  async findQuestionResponse(questionId: string): Promise<MessageInRow | undefined> {
    const row = await this.rpc<MessageInRow | null>('findQuestionResponse', { questionId });
    return row ?? undefined;
  }
  async writeMessageOut(msg: WriteMessageOut): Promise<number> {
    const res = await this.rpc<{ seq: number }>('writeMessageOut', { msg });
    return res.seq;
  }
  stageMemoryFile(document: string, id: string, filename?: string): Promise<{ filename: string } | { error: string }> {
    return this.rpc('stageMemoryFile', { document, id, filename });
  }
  getMessageIdBySeq(seq: number): Promise<string | null> {
    return this.rpc<string | null>('getMessageIdBySeq', { seq });
  }
  getRoutingBySeq(seq: number): Promise<RoutingBySeq | null> {
    return this.rpc<RoutingBySeq | null>('getRoutingBySeq', { seq });
  }
  writeStatus(ev: StatusEventOut): Promise<void> {
    return this.rpc<void>('writeStatus', { ...ev });
  }
  getDestinations(): Promise<DestRow[]> {
    return this.rpc<DestRow[]>('getDestinations', {});
  }
  getSessionRouting(): Promise<SessionRouting> {
    return this.rpc<SessionRouting>('getSessionRouting', {});
  }
  resolveDestinationThread(channelType: string, platformId: string): Promise<DestinationThread | null> {
    return this.rpc<DestinationThread | null>('resolveDestinationThread', { channelType, platformId });
  }
  listTasks(status?: string): Promise<TaskRow[]> {
    return this.rpc<TaskRow[]>('listTasks', { status: status ?? null });
  }
  async getSessionState(key: string): Promise<string | undefined> {
    const res = await this.rpc<{ value: string | null }>('getSessionState', { key });
    return res.value ?? undefined;
  }
  setSessionState(key: string, value: string): Promise<void> {
    return this.rpc<void>('setSessionState', { key, value });
  }
  recordUsage(delta: UsageDelta): Promise<void> {
    return this.rpc<void>('recordUsage', { ...delta });
  }
  getUsageSummary(episodeId?: string | null): Promise<UsageSummary> {
    return this.rpc<UsageSummary>('getUsageSummary', { episodeId: episodeId ?? null });
  }
  deleteSessionState(key: string): Promise<void> {
    return this.rpc<void>('deleteSessionState', { key });
  }
  findCliResponse(requestId: string): Promise<CliResponseRow | null> {
    return this.rpc<CliResponseRow | null>('findCliResponse', { requestId });
  }
  ping(info: PingInfo = {}): Promise<void> {
    return this.rpc<void>('ping', { ...info });
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests)
// ---------------------------------------------------------------------------

/** Shape of an outbound row held by the in-memory client (test assertions). */
export interface OutRowForTests {
  id: string;
  seq: number;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/** Inbound row plus the host-only `on_wake` flag the container never sees. */
type StoredInbound = MessageInRow & { on_wake: number };

export class InMemorySessionClient implements SessionClient {
  inbound: StoredInbound[] = [];
  outbound: OutRowForTests[] = [];
  /** Status events in emission order (ephemeral — no seq, no persistence). */
  statusEvents: StatusEventOut[] = [];
  destinations: DestRow[] = [];
  routing: SessionRouting = { channel_type: null, platform_id: null, thread_id: null };
  state = new Map<string, string>();
  delivered = new Map<string, string | null>();
  /** Deltas passed to recordUsage, for assertions. */
  usage: UsageDelta[] = [];
  /** Fixture returned by getUsageSummary; null means "nothing recorded yet". */
  usageSummary: UsageSummary | null = null;
  liveness: { lastSeenMs: number; tool: string | null; toolDeclaredTimeoutMs: number | null; toolStartedAt: string | null } = {
    lastSeenMs: 0,
    tool: null,
    toolDeclaredTimeoutMs: null,
    toolStartedAt: null,
  };
  maxMessagesPerPrompt = 10;

  private nextSeq(): number {
    const maxIn = this.inbound.reduce((m, r) => Math.max(m, r.seq ?? 0), 0);
    const maxOut = this.outbound.reduce((m, r) => Math.max(m, r.seq), 0);
    return Math.max(maxIn, maxOut) + 1;
  }

  /** Test helper: seed an inbound message as the host would. */
  stageMemoryFile(_document: string, _id: string, _filename?: string): Promise<{ filename: string } | { error: string }> {
    return Promise.resolve({ error: 'No memory file configured in the test session.' });
  }

  seedInbound(
    msg: Partial<MessageInRow> & { id: string; kind: string; content: string; on_wake?: number },
  ): MessageInRow {
    const row: StoredInbound = {
      id: msg.id,
      seq: msg.seq ?? this.nextSeq(),
      kind: msg.kind,
      timestamp: msg.timestamp ?? new Date().toISOString(),
      status: msg.status ?? 'pending',
      process_after: msg.process_after ?? null,
      recurrence: msg.recurrence ?? null,
      series_id: msg.series_id ?? null,
      tries: msg.tries ?? 0,
      trigger: msg.trigger ?? 1,
      platform_id: msg.platform_id ?? null,
      channel_type: msg.channel_type ?? null,
      thread_id: msg.thread_id ?? null,
      content: msg.content,
      on_wake: msg.on_wake ?? 0,
    };
    this.inbound.push(row);
    return row;
  }

  memoryEdits: MemoryEditContext[] = [];
  readMemoryEdits(): Promise<MemoryEditContext[]> { return Promise.resolve([...this.memoryEdits]); }
  acknowledgeMemoryEdits(ids: string[]): Promise<void> {
    this.memoryEdits = this.memoryEdits.filter(edit => !ids.includes(edit.id));
    return Promise.resolve();
  }
  getPendingMessages(isFirstPoll: boolean): Promise<MessageInRow[]> {
    const now = Date.now();
    const pending = this.inbound
      .filter((m) => m.status === 'pending')
      .filter((m) => !m.process_after || Date.parse(m.process_after) <= now)
      // on_wake=1 rows are only surfaced on the very first poll after a spawn.
      .filter((m) => isFirstPoll || m.on_wake !== 1)
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
      .slice(0, this.maxMessagesPerPrompt);
    return Promise.resolve(pending.reverse());
  }
  markProcessing(ids: string[]): Promise<void> {
    for (const m of this.inbound) if (ids.includes(m.id)) m.status = 'processing';
    return Promise.resolve();
  }
  markCompleted(ids: string[]): Promise<void> {
    for (const m of this.inbound) if (ids.includes(m.id)) m.status = 'completed';
    return Promise.resolve();
  }
  findQuestionResponse(questionId: string): Promise<MessageInRow | undefined> {
    const row = this.inbound.find((m) => m.status === 'pending' && m.content.includes(`"questionId":"${questionId}"`));
    return Promise.resolve(row);
  }
  writeMessageOut(msg: WriteMessageOut): Promise<number> {
    const seq = this.nextSeq();
    this.outbound.push({
      id: msg.id,
      seq,
      in_reply_to: msg.in_reply_to ?? null,
      timestamp: new Date().toISOString(),
      deliver_after: msg.deliver_after ?? null,
      recurrence: msg.recurrence ?? null,
      kind: msg.kind,
      platform_id: msg.platform_id ?? null,
      channel_type: msg.channel_type ?? null,
      thread_id: msg.thread_id ?? null,
      content: msg.content,
    });
    return Promise.resolve(seq);
  }
  writeStatus(ev: StatusEventOut): Promise<void> {
    this.statusEvents.push({ ...ev, payload: { ...ev.payload } });
    return Promise.resolve();
  }
  getMessageIdBySeq(seq: number): Promise<string | null> {
    const inRow = this.inbound.find((m) => m.seq === seq);
    if (inRow) return Promise.resolve(inRow.id);
    const outRow = this.outbound.find((m) => m.seq === seq);
    if (!outRow) return Promise.resolve(null);
    const platform = this.delivered.get(outRow.id);
    return Promise.resolve(platform ?? outRow.id);
  }
  getRoutingBySeq(seq: number): Promise<RoutingBySeq | null> {
    const inRow = this.inbound.find((m) => m.seq === seq);
    if (inRow) {
      return Promise.resolve({
        channel_type: inRow.channel_type,
        platform_id: inRow.platform_id,
        thread_id: inRow.thread_id,
      });
    }
    const outRow = this.outbound.find((m) => m.seq === seq);
    if (!outRow) return Promise.resolve(null);
    return Promise.resolve({
      channel_type: outRow.channel_type,
      platform_id: outRow.platform_id,
      thread_id: outRow.thread_id,
    });
  }
  getDestinations(): Promise<DestRow[]> {
    return Promise.resolve([...this.destinations].sort((a, b) => a.name.localeCompare(b.name)));
  }
  getSessionRouting(): Promise<SessionRouting> {
    return Promise.resolve({ ...this.routing });
  }
  resolveDestinationThread(channelType: string, platformId: string): Promise<DestinationThread | null> {
    const match = [...this.inbound]
      .filter((m) => m.channel_type === channelType && m.platform_id === platformId)
      .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0];
    if (!match) return Promise.resolve(null);
    return Promise.resolve({ threadId: match.thread_id, inReplyTo: match.id });
  }
  listTasks(status?: string): Promise<TaskRow[]> {
    const seen = new Set<string>();
    const rows: TaskRow[] = [];
    for (const m of [...this.inbound].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))) {
      if (m.kind !== 'task') continue;
      if (status ? m.status !== status : m.status !== 'pending' && m.status !== 'paused') continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      rows.push({ id: m.id, status: m.status, process_after: m.process_after, recurrence: m.recurrence, content: m.content });
    }
    return Promise.resolve(rows);
  }
  getSessionState(key: string): Promise<string | undefined> {
    return Promise.resolve(this.state.get(key));
  }
  setSessionState(key: string, value: string): Promise<void> {
    this.state.set(key, value);
    return Promise.resolve();
  }
  deleteSessionState(key: string): Promise<void> {
    this.state.delete(key);
    return Promise.resolve();
  }
  recordUsage(delta: UsageDelta): Promise<void> {
    this.usage.push(delta);
    return Promise.resolve();
  }
  getUsageSummary(episodeId?: string | null): Promise<UsageSummary> {
    if (this.usageSummary) {
      return Promise.resolve(
        episodeId?.trim() ? this.usageSummary : { ...this.usageSummary, topic: null },
      );
    }
    const zero = {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      promptTokensCacheKnown: 0,
      turns: 0,
    };
    return Promise.resolve({
      today: { ...zero },
      month: { ...zero },
      session: { ...zero },
      topic: null,
      updatedAt: null,
    });
  }
  findCliResponse(requestId: string): Promise<CliResponseRow | null> {
    const row = this.inbound.find((m) => m.status === 'pending' && m.content.includes(`"requestId":"${requestId}"`));
    return Promise.resolve(row ? { id: row.id, content: row.content } : null);
  }
  ping(info: PingInfo = {}): Promise<void> {
    this.liveness.lastSeenMs = Date.now();
    if (info.setTool) {
      this.liveness.tool = info.tool ?? null;
      this.liveness.toolDeclaredTimeoutMs = info.toolDeclaredTimeoutMs ?? null;
      this.liveness.toolStartedAt = info.toolStartedAt ?? null;
    }
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Singleton selection
// ---------------------------------------------------------------------------

let _client: SessionClient | null = null;

export function setSessionClient(client: SessionClient | null): void {
  _client = client;
}

export function getSessionClient(): SessionClient {
  if (!_client) {
    _client = new HttpSessionClient();
  }
  return _client;
}
