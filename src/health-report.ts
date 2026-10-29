/**
 * Shared install health report for `luna health` and Telegram `/health`.
 * Fast (~1–3s): cached Apple/email probes, config-based models + short
 * reachability checks, OneCLI 2s ping, live host runtime when available.
 */
import fs from 'fs';
import path from 'path';

import { getChannelAdapter, getRegisteredChannelNames } from './channels/channel-registry.js';
import { CENTRAL_DB_PATH, ONECLI_URL } from './config.js';
import { configLayerErrors, loadLunaConfig, resolveModelRole } from './config/loader.js';
import type { ModelRole } from './config/schema.js';
import { getActiveContainerCount, isContainerRunning } from './container-runner.js';
import { CONTAINER_HOST_ALIAS, CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { getDb } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION } from './db/initialize.js';
import { countDueMessages, countFailedDeliveries, getProcessingClaims } from './db/session-db.js';
import { getActiveSessions } from './db/sessions.js';
import { isAppleBuiltinEnabled } from './host-mcp/builtins/apple/provider.js';
import { APPLE_APP_ORDER, type AppleAppId } from './host-mcp/builtins/apple/shared/types.js';
import { resolveAppleHealthPath } from './host-mcp/builtins/apple/shared/paths.js';
import type { AppleHealth } from './host-mcp/builtins/apple/shared/permissions.js';
import { isEmailBuiltinEnabled } from './host-mcp/builtins/email/provider.js';
import { readMailHealth } from './host-mcp/builtins/email/shared/health.js';
import { buildHostMcpRegistry } from './host-mcp/registry.js';
import { getHostMcpSupervisorState } from './host-mcp/supervisor.js';
import { DEFAULT_ONECLI_URL, pollOneCliHealth } from './onecli-runtime.js';
import { describeChatGptLoginProblem, readChatGptLogin, type ChatGptLoginState } from './providers/chatgpt.js';
import { readErrorLogSinceBoot } from './host-boot.js';
import { getServiceInfo } from './service/host-service.js';
import { getLiveness } from './session-liveness.js';
import { openSession } from './session-manager.js';
import { isMemoryBuiltinEnabled, memoryHealth, memorySocketPath } from './host-mcp/builtins/memory/provider.js';
import { selectBackend, voiceSettings } from './voice/transcribe.js';
import { configUsers, ownerKey, validateRoster } from './users/roster.js';
import type { MemoryMaintenanceHealth } from './memory/health.js';

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export type OverallHealth = 'ok' | 'degraded' | 'fail';

export interface HealthSectionBase {
  status: HealthStatus;
  detail: string;
}

export interface ServiceHealthSection extends HealthSectionBase {
  manager: string;
  state: string;
  pid: number | null;
}

export interface DatabaseHealthSection extends HealthSectionBase {
  path: string;
  openable: boolean;
  schema_version_ok: boolean;
  active_sessions: number;
  due_messages: number;
  processing_claims: number;
  /** Outbound messages abandoned after exhausting their delivery attempts. */
  failed_deliveries: number;
}

export interface ModelRoleHealth {
  role: ModelRole;
  provider: string;
  id: string | null;
  baseUrl: string | null;
  apiKeyPresent: boolean;
  /** For `auth: "chatgpt"` providers, the state of Codex's login in place of an API key. */
  chatgptLogin?: ChatGptLoginState['status'];
  reachability: 'ok' | 'unreachable' | 'skipped';
  enabled?: boolean;
  dimensions?: number | null;
}

export interface ModelsHealthSection extends HealthSectionBase {
  roles: ModelRoleHealth[];
}

/**
 * Memory, as Luna can see it from outside.
 *
 * Connection health and maintenance health are independent: interactive memory can work while
 * automatic synthesis is paused. Akno owns both reports; Luna does not infer a schedule or run it.
 */
export interface MemoryHealthSection extends HealthSectionBase {
  enabled: boolean;
  socket: string;
  reachable: boolean;
  /** False when another process holds the write handle — reads work, every write fails. */
  writable: boolean;
  /** Whether conversations are digested after a turn. */
  digest: boolean;
  /** Absent when formatting a report from a host that predates maintenance health. */
  maintenance?: MemoryMaintenanceHealth;
}

export interface BuiltinsHealthSection extends HealthSectionBase {
  apple: {
    enabled: boolean;
    apps: Array<{ app: AppleAppId; status: string; message?: string }>;
  };
  email: {
    enabled: boolean;
    /** Per mailbox, because one revoked app password is not the whole builtin being down. */
    mailboxes: Array<{ key: string; ok: boolean; detail: string }>;
    cached: { status: string; message: string; checkedAt: string } | null;
  };
  hostMcp: {
    port: number | null;
    supervisorUp: boolean;
    servers: string[];
  };
}

export interface OneCliHealthSection extends HealthSectionBase {
  url: string | null;
  healthy: boolean | null;
}

export interface RuntimeSessionHealth {
  id: string;
  agent_group_id: string;
  container_running: boolean;
  last_ping_age_ms: number | null;
  tool: string | null;
}

export interface RuntimeHealthSection extends HealthSectionBase {
  containers_active: number;
  channel_adapters: Array<{ type: string; registered: boolean }>;
  sessions: RuntimeSessionHealth[];
}

export interface ErrorsHealthSection extends HealthSectionBase {
  recent: string[];
}

/**
 * Whether a voice message would actually be heard.
 *
 * Both backends depend on something outside Luna — an on-device asset plus a TCC grant, or a
 * model the account is entitled to — and both fail in ways that look like silence to whoever
 * just spoke. This is where that shows up before a voice note does.
 */
export interface VoiceHealthSection extends HealthSectionBase {
  enabled: boolean;
  backend: 'auto' | 'macos' | 'model';
  resolved: 'macos' | 'model' | null;
  languages: string[];
}

export interface HealthReport {
  overall: OverallHealth;
  checkedAt: string;
  service: ServiceHealthSection;
  database: DatabaseHealthSection;
  models: ModelsHealthSection;
  memory: MemoryHealthSection;
  /** Absent in a report produced by a host older than this feature. */
  voice?: VoiceHealthSection;
  builtins: BuiltinsHealthSection;
  onecli: OneCliHealthSection;
  runtime: RuntimeHealthSection;
  errors: ErrorsHealthSection;
}

/** Type guard for CLI human formatting (`luna health` without `--json`). */
export function isHealthReport(data: unknown): data is HealthReport {
  if (!data || typeof data !== 'object') return false;
  const r = data as Record<string, unknown>;
  return (
    typeof r.overall === 'string' &&
    typeof r.checkedAt === 'string' &&
    isSection(r.service) &&
    isSection(r.database) &&
    isSection(r.models) &&
    isSection(r.memory) &&
    isSection(r.builtins) &&
    isSection(r.onecli) &&
    isSection(r.runtime) &&
    isSection(r.errors)
  );
}

function isSection(v: unknown): boolean {
  return Boolean(v && typeof v === 'object' && typeof (v as HealthSectionBase).status === 'string');
}

const MODEL_ROLES: ModelRole[] = ['main'];
const REACHABILITY_MS = 2000;
const ONECLI_PING_MS = 2000;

export function rollupOverall(sections: HealthSectionBase[]): OverallHealth {
  const statuses = sections.map((s) => s.status);
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'degraded';
  return 'ok';
}

function statusIcon(status: HealthStatus | OverallHealth): string {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'degraded':
    case 'warn':
      return 'warn';
    case 'fail':
      return 'fail';
    case 'skipped':
      return 'skip';
  }
}

function statusEmoji(status: HealthStatus | OverallHealth): string {
  switch (status) {
    case 'ok':
      return '✅';
    case 'degraded':
    case 'warn':
      return '⚠️';
    case 'fail':
      return '❌';
    case 'skipped':
      return '⏭️';
  }
}

interface HealthRow {
  name: string;
  status: HealthStatus;
  /** Primary detail line(s); extras are appended for display. */
  detail: string;
  extra?: string;
}

/** Who this install will talk to, and whether the config saying so is usable. */
function rosterRow(): HealthRow {
  const parseErrors = configLayerErrors();
  if (parseErrors.length > 0) {
    return {
      name: 'Users',
      status: 'fail',
      detail: 'config could not be parsed — running on defaults, so nobody is configured',
      extra: parseErrors.map((e) => `${e.path}: ${e.message}`).join('; '),
    };
  }

  const problems = validateRoster();
  const users = configUsers();
  const owner = ownerKey();
  const enabled = users.filter((u) => u.enabled).length;

  if (problems.length > 0) {
    return {
      name: 'Users',
      status: 'fail',
      detail: `${problems.length} problem${problems.length === 1 ? '' : 's'} in the configured roster`,
      extra: problems.map((p) => (p.key ? `${p.key}: ${p.message}` : p.message)).join('; '),
    };
  }

  if (users.length === 0) {
    return {
      name: 'Users',
      status: 'warn',
      detail: 'nobody configured — only the host terminal can talk to this install',
    };
  }

  return {
    name: 'Users',
    status: 'ok',
    detail: `${enabled} configured, owner=${owner ?? '—'}`,
    extra: enabled === users.length ? undefined : `${users.length - enabled} disabled`,
  };
}

/** Shared section rows for CLI + Telegram formatters. */
function buildHealthRows(report: HealthReport): HealthRow[] {
  const rows: HealthRow[] = [];

  rows.push({ name: 'Service', status: report.service.status, detail: report.service.detail });

  // Computed here rather than carried on the report: it is a pure function of the config file, needs
  // no probe, and the reason it is on this screen is that a bad roster is otherwise silent — an
  // install that answers nobody looks identical to one nobody has messaged.
  rows.push(rosterRow());

  rows.push({
    name: 'Database',
    status: report.database.status,
    detail: report.database.detail,
    extra:
      report.database.status !== 'ok'
        ? `due=${report.database.due_messages} claims=${report.database.processing_claims} failed=${report.database.failed_deliveries}`
        : undefined,
  });

  const modelBits = report.models.roles
    .map((r) => {
      const mark = r.reachability === 'unreachable' ? '!' : '';
      return `${r.role}=${r.id ?? '—'}${mark}`;
    })
    .join(', ');
  rows.push({
    name: 'Models',
    status: report.models.status,
    detail: report.models.detail,
    extra: report.models.status === 'ok' ? undefined : modelBits,
  });

  rows.push({
    name: 'Memory',
    status: !report.memory.enabled ? 'ok' : !report.memory.reachable ? 'fail' : report.memory.writable ? 'ok' : 'warn',
    detail: report.memory.detail,
    extra: report.memory.enabled ? `digest=${report.memory.digest ? 'on' : 'off'}` : undefined,
  });
  if (report.memory.enabled) {
    const maintenance = report.memory.maintenance;
    rows.push({
      name: 'Memory maintenance',
      status: maintenance?.status ?? 'warn',
      detail: maintenance?.detail ?? 'Maintenance status is unavailable from this Luna host.',
      extra: maintenance?.guidance,
    });
  }

  // Optional on purpose: `luna health` renders a report fetched from the running host over a
  // socket, and a CLI newer than the host it is asking gets a report with no `voice` in it. That
  // is the ordinary state during a deploy, and it must render rather than throw.
  if (report.voice?.enabled) {
    rows.push({
      name: 'Voice',
      status: report.voice.status,
      detail: report.voice.detail,
      extra: `languages=${report.voice.languages.join(', ')}`,
    });
  }

  const mcp =
    report.builtins.hostMcp.servers.length > 0 && report.builtins.status === 'ok'
      ? `mcp: ${report.builtins.hostMcp.servers.join(', ')}`
      : undefined;
  rows.push({
    name: 'Builtins',
    status: report.builtins.status,
    detail: report.builtins.detail,
    extra: mcp,
  });

  rows.push({ name: 'OneCLI', status: report.onecli.status, detail: report.onecli.detail });

  const sessionLines =
    report.runtime.sessions.length > 0
      ? report.runtime.sessions
          .slice(0, 3)
          .map((s) => {
            const ping = s.last_ping_age_ms != null ? `${Math.round(s.last_ping_age_ms / 1000)}s` : 'never';
            return `${s.id.slice(0, 8)}… ctr=${s.container_running ? 'up' : 'down'} ping=${ping}`;
          })
          .join('\n')
      : undefined;
  rows.push({
    name: 'Runtime',
    status: report.runtime.status,
    detail: report.runtime.detail,
    extra: sessionLines,
  });

  if (report.errors.recent.length > 0) {
    rows.push({
      name: 'Errors',
      status: report.errors.status,
      detail: report.errors.detail,
      extra: report.errors.recent[report.errors.recent.length - 1]?.slice(0, 120),
    });
  } else {
    rows.push({ name: 'Errors', status: report.errors.status, detail: report.errors.detail });
  }

  return rows;
}

function truncateHealthText(text: string, max = 3900): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…';
}

/** Escape a GFM table cell (pipes + newlines). */
function mdTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' · ');
}

function readAppleHealthCache(): AppleHealth | null {
  try {
    const p = resolveAppleHealthPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as AppleHealth;
  } catch {
    return null;
  }
}

function hostReachableHttpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Config often uses container-side hostnames; host probes need loopback.
    if (
      parsed.hostname === CONTAINER_HOST_ALIAS ||
      parsed.hostname === CONTAINER_HOST_GATEWAY ||
      parsed.hostname === 'localhost'
    ) {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
  } catch {
    // leave as-is
  }
  return url;
}

async function probeBaseUrl(baseUrl: string): Promise<'ok' | 'unreachable'> {
  const probeUrl = hostReachableHttpUrl(baseUrl);
  try {
    await fetch(probeUrl, { signal: AbortSignal.timeout(REACHABILITY_MS), redirect: 'manual' });
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

function collectService(): ServiceHealthSection {
  const info = getServiceInfo();
  let status: HealthStatus = 'ok';
  let detail = `${info.manager} ${info.state}`;
  if (info.state === 'not_installed') {
    status = 'warn';
    detail = 'service not installed';
  } else if (info.state === 'stopped') {
    status = 'fail';
    detail = 'service stopped';
  } else if (info.pid) {
    detail = `${info.manager} running pid=${info.pid}`;
  }
  return {
    status,
    detail,
    manager: info.manager,
    state: info.state,
    pid: info.pid,
  };
}

function collectDatabase(): DatabaseHealthSection {
  const dbPath = CENTRAL_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return {
      status: 'fail',
      detail: 'central DB missing',
      path: dbPath,
      openable: false,
      schema_version_ok: false,
      active_sessions: 0,
      due_messages: 0,
      processing_claims: 0,
      failed_deliveries: 0,
    };
  }

  try {
    const db = getDb();
    const schemaOk = db.pragma('user_version', { simple: true }) === DATABASE_SCHEMA_VERSION;
    const sessions = getActiveSessions();
    let due = 0;
    let claims = 0;
    let failed = 0;
    for (const session of sessions) {
      try {
        const sdb = openSession(session.agent_group_id, session.id);
        try {
          due += countDueMessages(sdb);
          claims += getProcessingClaims(sdb).length;
          failed += countFailedDeliveries(sdb);
        } finally {
          sdb.close();
        }
      } catch {
        // session db may be absent for a stale row
      }
    }

    let status: HealthStatus = 'ok';
    let detail = `${sessions.length} active session(s)`;
    if (!schemaOk) {
      status = 'fail';
      detail = 'Unsupported database schema version';
    } else if (claims > 0) {
      status = 'warn';
      detail = `${sessions.length} active; ${claims} processing claim(s); ${due} due`;
    } else if (due > 0) {
      status = 'warn';
      detail = `${sessions.length} active; ${due} due message(s)`;
    }
    // A dead-lettered message is a message the user never received. Surface it
    // even when everything else is quiet — it is otherwise only visible as one
    // log line at the moment delivery gave up.
    if (failed > 0 && status === 'ok') {
      status = 'warn';
      detail = `${sessions.length} active; ${failed} undelivered message(s)`;
    }

    return {
      status,
      detail,
      path: dbPath,
      openable: true,
      schema_version_ok: schemaOk,
      active_sessions: sessions.length,
      due_messages: due,
      processing_claims: claims,
      failed_deliveries: failed,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      path: dbPath,
      openable: false,
      schema_version_ok: false,
      active_sessions: 0,
      due_messages: 0,
      processing_claims: 0,
      failed_deliveries: 0,
    };
  }
}

async function collectModels(): Promise<ModelsHealthSection> {
  const roles: ModelRoleHealth[] = [];
  const urlReach = new Map<string, Promise<'ok' | 'unreachable'>>();

  for (const role of MODEL_ROLES) {
    const resolved = resolveModelRole(role);
    const baseUrl = resolved.provider.baseUrl ?? null;
    const chatgptLogin = resolved.provider.auth === 'chatgpt' ? readChatGptLogin().status : undefined;
    const apiKeyPresent = chatgptLogin ? chatgptLogin === 'ok' : Boolean(resolved.provider.apiKey);

    let reachability: ModelRoleHealth['reachability'] = 'skipped';
    if (baseUrl) {
      let pending = urlReach.get(baseUrl);
      if (!pending) {
        pending = probeBaseUrl(baseUrl);
        urlReach.set(baseUrl, pending);
      }
      reachability = await pending;
    }

    roles.push({
      role,
      provider: resolved.provider.name,
      id: resolved.id ?? null,
      baseUrl,
      apiKeyPresent,
      ...(chatgptLogin ? { chatgptLogin } : {}),
      reachability,
    });
  }

  const problems: string[] = [];
  let loginFailed = false;
  for (const r of roles) {
    if (!r.id) {
      problems.push(`${r.role}: no model id`);
    }
    if (r.chatgptLogin && r.chatgptLogin !== 'ok') {
      loginFailed = true;
      problems.push(`${r.role}: ${describeChatGptLoginProblem(r.chatgptLogin)}`);
    } else if (!r.apiKeyPresent && r.baseUrl) {
      // local endpoints often need no key; only warn when remote-ish and missing
      const host = (() => {
        try {
          return new URL(r.baseUrl).hostname;
        } catch {
          return r.baseUrl;
        }
      })();
      if (
        host !== 'localhost' &&
        host !== '127.0.0.1' &&
        host !== CONTAINER_HOST_ALIAS &&
        host !== CONTAINER_HOST_GATEWAY
      ) {
        problems.push(`${r.role}: API key missing`);
      }
    }
    if (r.reachability === 'unreachable') {
      problems.push(`${r.role}: unreachable ${r.baseUrl}`);
    }
  }

  let status: HealthStatus = 'ok';
  let detail = roles.map((r) => `${r.role}=${r.id ?? 'unset'}`).join(', ');
  if (loginFailed || problems.some((p) => p.includes('unreachable') || p.includes('no model id'))) {
    status = 'fail';
    detail = problems.join('; ');
  } else if (problems.length > 0) {
    status = 'warn';
    detail = problems.join('; ');
  }

  return { status, detail, roles };
}

export async function collectMemoryHealth(): Promise<MemoryHealthSection> {
  const enabled = isMemoryBuiltinEnabled();
  const socket = memorySocketPath();
  const digest = loadLunaConfig().memory?.digest !== false;

  if (!enabled) {
    return {
      status: 'ok',
      detail: 'disabled (memory.enabled=false)',
      enabled: false,
      socket,
      reachable: false,
      writable: false,
      digest: false,
      maintenance: { status: 'skipped', state: 'disabled', detail: 'Memory is disabled.' },
    };
  }

  const health = await memoryHealth();
  // Unreachable is a hard fail: an assistant that cannot read its memory will answer as though the
  // user never told it anything, which is worse than saying it is broken.
  const status: HealthStatus = !health.ok
    ? 'fail'
    : !health.writable || health.maintenance.status === 'warn'
      ? 'warn'
      : 'ok';

  return {
    status,
    detail: health.detail,
    enabled: true,
    socket,
    reachable: health.ok,
    writable: health.writable,
    digest,
    maintenance: health.maintenance,
  };
}

function collectBuiltins(): BuiltinsHealthSection {
  const appleEnabled = isAppleBuiltinEnabled();
  const appleCache = readAppleHealthCache();
  const appleApps: BuiltinsHealthSection['apple']['apps'] = [];
  if (appleEnabled) {
    for (const app of APPLE_APP_ORDER) {
      const entry = appleCache?.[app];
      appleApps.push({
        app,
        status: entry?.status ?? 'unknown',
        message: entry?.message,
      });
    }
  }

  const emailEnabled = isEmailBuiltinEnabled();
  const emailCached = readMailHealth();

  const registry = buildHostMcpRegistry();
  const supervisor = getHostMcpSupervisorState();
  const servers = Object.keys(registry.providers).sort();

  const issues: string[] = [];
  if (appleEnabled) {
    for (const a of appleApps) {
      if (a.status === 'denied' || a.status === 'error' || a.status === 'missing_cli') {
        issues.push(`apple.${a.app}=${a.status}`);
      }
    }
    if (!appleCache) issues.push('apple health cache missing');
  }
  if (emailEnabled) {
    if (!emailCached) {
      issues.push('email health cache missing');
    } else if (emailCached.status !== 'ok') {
      // Named per mailbox: one revoked app password must not read as "mail is down".
      const broken = emailCached.mailboxes.filter((m) => !m.ok).map((m) => m.key);
      issues.push(
        broken.length > 0 ? `email=${emailCached.status} (${broken.join(', ')})` : `email=${emailCached.status}`,
      );
    }
  }

  let status: HealthStatus = 'ok';
  let detail = `mcp servers=${servers.length}`;
  if (appleEnabled || emailEnabled) {
    const parts: string[] = [];
    if (appleEnabled) {
      const bad = appleApps.filter((a) => a.status !== 'ok' && a.status !== 'disabled').length;
      parts.push(bad === 0 ? 'apple ok' : `apple issues=${bad}`);
    }
    if (emailEnabled) {
      parts.push(emailCached ? `email ${emailCached.status}` : 'email uncached');
    }
    detail = parts.join(', ');
  }
  if (
    issues.some((i) => i.includes('denied') || i.includes('missing') || i.includes('error') || i.includes('config'))
  ) {
    status = issues.some((i) => i.includes('denied') || i.includes('missing_cli') || i.includes('auth_failed'))
      ? 'fail'
      : 'warn';
    detail = issues.slice(0, 4).join('; ');
  } else if (issues.length > 0) {
    status = 'warn';
    detail = issues.slice(0, 4).join('; ');
  }

  if (!supervisor && (appleEnabled || emailEnabled || servers.length > 0)) {
    if (status === 'ok') status = 'warn';
    detail = `${detail}; host MCP supervisor down`.replace(/^; /, '');
  }

  return {
    status,
    detail,
    apple: { enabled: appleEnabled, apps: appleApps },
    email: {
      enabled: emailEnabled,
      mailboxes: emailCached?.mailboxes.map((m) => ({ key: m.key, ok: m.ok, detail: m.detail })) ?? [],
      cached: emailCached
        ? { status: emailCached.status, message: emailCached.message, checkedAt: emailCached.checkedAt }
        : null,
    },
    hostMcp: {
      port: supervisor?.port ?? registry.port,
      supervisorUp: Boolean(supervisor),
      servers,
    },
  };
}

async function collectOneCli(): Promise<OneCliHealthSection> {
  const url = ONECLI_URL || DEFAULT_ONECLI_URL;
  if (!ONECLI_URL && !url) {
    return { status: 'skipped', detail: 'not configured', url: null, healthy: null };
  }
  const healthy = await pollOneCliHealth(url, ONECLI_PING_MS);
  return {
    status: healthy ? 'ok' : 'fail',
    detail: healthy ? `healthy ${url}` : `unreachable ${url}`,
    url,
    healthy,
  };
}

function collectRuntime(): RuntimeHealthSection {
  const channels = getRegisteredChannelNames().map((t) => ({
    type: t,
    registered: Boolean(getChannelAdapter(t)),
  }));
  const unregistered = channels.filter((c) => !c.registered);
  let sessions: RuntimeSessionHealth[] = [];
  try {
    sessions = getActiveSessions().map((s) => {
      const live = getLiveness(s.id);
      const lastPingAge = live && live.lastSeenMs > 0 ? Date.now() - live.lastSeenMs : null;
      return {
        id: s.id,
        agent_group_id: s.agent_group_id,
        container_running: isContainerRunning(s.id),
        last_ping_age_ms: lastPingAge,
        tool: live?.tool ?? null,
      };
    });
  } catch {
    sessions = [];
  }

  const containers = getActiveContainerCount();
  let status: HealthStatus = 'ok';
  let detail = `${containers} container(s), ${sessions.length} session(s)`;
  if (unregistered.length > 0) {
    status = 'warn';
    detail = `adapters missing: ${unregistered.map((c) => c.type).join(', ')}`;
  }

  return {
    status,
    detail,
    containers_active: containers,
    channel_adapters: channels,
    sessions,
  };
}

function collectErrors(): ErrorsHealthSection {
  const errorLog = path.join(process.cwd(), 'logs', 'luna.error.log');
  // luna.error.log is append-only across restarts. Only score lines after the
  // latest host-boot marker so fixed issues (e.g. Messages FDA) stop WARN'ing.
  // luna.error.log often receives stderr startup chatter (host-mcp listening, …).
  // Keep lines that look like real problems only.
  const NOISE = /listening on|builtin ready|started with|Central DB initialized|\[luna\] host boot /i;
  const SIGNAL = /\b(error|fail|denied|ECONN|ENOENT|unauthorized|crash)\b/i;
  const recent = readErrorLogSinceBoot(errorLog)
    .filter((line) => SIGNAL.test(line) && !NOISE.test(line))
    .slice(-3);
  return {
    status: recent.length > 0 ? 'warn' : 'ok',
    detail: recent.length > 0 ? `${recent.length} recent error line(s)` : 'no recent errors',
    recent,
  };
}

/**
 * Resolve the voice backend the way a real message would, and report what it found.
 *
 * `selectBackend` is cached and side-effect free, so asking here costs one helper spawn the
 * first time and nothing after — and it surfaces the two things that silently break this: a
 * missing TCC grant, and a language macOS has no on-device asset for.
 */
async function collectVoice(): Promise<VoiceHealthSection> {
  const settings = voiceSettings();
  if (!settings.enabled) {
    return {
      status: 'ok',
      detail: 'off — voice messages arrive as attachments with no text',
      enabled: false,
      backend: settings.backend,
      resolved: null,
      languages: settings.languages,
    };
  }

  try {
    const choice = await selectBackend(settings);
    return {
      // A configured `macos` that fell back would have thrown; reaching here means the chosen
      // backend is the one that will run.
      status: 'ok',
      detail: `${choice.backend}${choice.locale ? ` (${choice.locale})` : ''} — ${choice.reason}`,
      enabled: true,
      backend: settings.backend,
      resolved: choice.backend,
      languages: settings.languages,
    };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      enabled: true,
      backend: settings.backend,
      resolved: null,
      languages: settings.languages,
    };
  }
}

export async function collectHealthReport(): Promise<HealthReport> {
  const [models, onecli, memory, voice] = await Promise.all([
    collectModels(),
    collectOneCli(),
    collectMemoryHealth(),
    collectVoice(),
  ]);
  const service = collectService();
  const database = collectDatabase();
  const builtins = collectBuiltins();
  const runtime = collectRuntime();
  const errors = collectErrors();

  const overall = rollupOverall([service, database, models, memory, voice, builtins, onecli, runtime, errors]);

  return {
    overall,
    checkedAt: new Date().toISOString(),
    service,
    database,
    models,
    memory,
    voice,
    builtins,
    onecli,
    runtime,
    errors,
  };
}

function displayOverall(report: HealthReport): OverallHealth {
  return report.overall === 'ok' &&
    report.memory.enabled &&
    (!report.memory.maintenance || report.memory.maintenance.status === 'warn')
    ? 'degraded'
    : report.overall;
}

/** Compact CLI / plain-text summary (under message length limits). */
export function formatHealthText(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Health: ${statusIcon(displayOverall(report)).toUpperCase()}`);
  lines.push('');

  for (const row of buildHealthRows(report)) {
    lines.push(`${statusIcon(row.status).toUpperCase()}  ${row.name}`);
    lines.push(`  ${row.detail}`);
    if (row.extra) {
      for (const extraLine of row.extra.split('\n')) {
        lines.push(`  ${extraLine}`);
      }
    }
    lines.push('');
  }

  return truncateHealthText(lines.join('\n').trimEnd());
}

/**
 * Telegram Rich Markdown: emoji status + GFM table.
 * Deliver without `plain: true` so tables render.
 */
export function formatHealthMarkdown(report: HealthReport): string {
  const lines: string[] = [];
  const overall = displayOverall(report);
  lines.push(`**Health** ${statusEmoji(overall)} ${statusIcon(overall).toUpperCase()}`);
  lines.push('');
  lines.push('| | Check | Detail |');
  lines.push('|---|---|---|');

  for (const row of buildHealthRows(report)) {
    const detail = row.extra ? `${row.detail} · ${row.extra}` : row.detail;
    lines.push(`| ${statusEmoji(row.status)} | ${row.name} | ${mdTableCell(detail)} |`);
  }

  return truncateHealthText(lines.join('\n').trimEnd());
}
