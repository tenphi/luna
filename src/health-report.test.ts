import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryProbe = vi.hoisted(() => ({ enabled: vi.fn(), health: vi.fn() }));
vi.mock('./host-mcp/builtins/memory/provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host-mcp/builtins/memory/provider.js')>()),
  isMemoryBuiltinEnabled: memoryProbe.enabled,
  memoryHealth: memoryProbe.health,
  memorySocketPath: () => '/tmp/invented-akno.sock',
}));
vi.mock('./config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config/loader.js')>()),
  loadLunaConfig: () => ({ memory: { digest: true } }),
  configLayerErrors: () => [],
}));

import {
  formatHealthMarkdown,
  collectMemoryHealth,
  formatHealthText,
  isHealthReport,
  rollupOverall,
  type HealthReport,
  type HealthSectionBase,
} from './health-report.js';

function section(status: HealthSectionBase['status'], detail = status): HealthSectionBase {
  return { status, detail };
}

function fixtureReport(overrides: Partial<HealthReport> = {}): HealthReport {
  const base: HealthReport = {
    overall: 'ok',
    checkedAt: '2026-07-23T00:00:00.000Z',
    service: { status: 'ok', detail: 'launchd running pid=1', manager: 'launchd', state: 'running', pid: 1 },
    database: {
      status: 'ok',
      detail: '1 active session(s)',
      path: '/tmp/luna.db',
      openable: true,
      schema_version_ok: true,
      active_sessions: 1,
      due_messages: 0,
      processing_claims: 0,
      failed_deliveries: 0,
    },
    models: {
      status: 'ok',
      detail: 'main=gpt, embedding=text',
      roles: [
        {
          role: 'main',
          provider: 'openai',
          id: 'gpt',
          baseUrl: 'http://localhost:11434/v1',
          apiKeyPresent: true,
          reachability: 'ok',
        },
      ],
    },
    memory: {
      status: 'ok',
      detail: '/Users/x/Knowledge, 11 ops',
      enabled: true,
      socket: '/Users/x/.akno/akno.sock',
      reachable: true,
      writable: true,
      digest: true,
      maintenance: { status: 'ok', state: 'healthy', detail: 'The scheduled maintenance cycle completed.' },
    },
    voice: {
      status: 'ok',
      detail: 'macos (en-US) — every configured language is on-device',
      enabled: true,
      backend: 'auto',
      resolved: 'macos',
      languages: ['en-US'],
    },
    builtins: {
      status: 'ok',
      detail: 'apple ok, email ok',
      apple: { enabled: false, apps: [] },
      email: { enabled: false, mailboxes: [], cached: null },
      hostMcp: { port: 18800, supervisorUp: true, servers: ['apple_calendar'] },
    },
    onecli: { status: 'ok', detail: 'healthy http://127.0.0.1:10254', url: 'http://127.0.0.1:10254', healthy: true },
    runtime: {
      status: 'ok',
      detail: '1 container(s), 1 session(s)',
      containers_active: 1,
      channel_adapters: [{ type: 'telegram', registered: true }],
      sessions: [
        {
          id: 'session-abcdef12',
          agent_group_id: 'ag-1',
          container_running: true,
          last_ping_age_ms: 1500,
          tool: null,
        },
      ],
    },
    errors: { status: 'ok', detail: 'no recent errors', recent: [] },
  };
  return { ...base, ...overrides, overall: overrides.overall ?? base.overall };
}

beforeEach(() => {
  memoryProbe.enabled.mockReset().mockReturnValue(true);
  memoryProbe.health.mockReset().mockResolvedValue({
    ok: true,
    writable: true,
    detail: 'Connected; memory reads and writes are available.',
    maintenance: { status: 'ok', state: 'healthy', detail: 'Maintenance completed.' },
  });
});

describe('memory health collection', () => {
  it('makes a reachable but paused service a warning without disabling interactive memory', async () => {
    memoryProbe.health.mockResolvedValue({
      ok: true,
      writable: true,
      detail: 'Connected; memory reads and writes are available.',
      maintenance: {
        status: 'warn',
        state: 'paused',
        detail: 'Automatic maintenance is paused.',
        guidance: 'Inspect with `akno dream status`.',
      },
    });
    const memory = await collectMemoryHealth();
    expect(memory).toMatchObject({
      status: 'warn',
      reachable: true,
      writable: true,
      digest: true,
      maintenance: { state: 'paused' },
    });
    expect(rollupOverall([section('ok'), memory])).toBe('degraded');
    const report = fixtureReport({ overall: 'degraded', memory });
    const text = formatHealthText(report);
    expect(text).toContain('OK  Memory\n');
    expect(text).toContain('WARN  Memory maintenance');
    expect(text).toContain('akno dream status');
    const markdown = formatHealthMarkdown(report);
    expect(markdown).toContain('| ✅ | Memory |');
    expect(markdown).toContain('| ⚠️ | Memory maintenance |');
  });

  it('fails an unreachable connection and warns on a read-only connection', async () => {
    memoryProbe.health.mockResolvedValue({
      ok: false,
      writable: false,
      detail: 'Unavailable',
      maintenance: { status: 'warn', state: 'unavailable', detail: 'Unknown' },
    });
    expect((await collectMemoryHealth()).status).toBe('fail');
    memoryProbe.health.mockResolvedValue({
      ok: true,
      writable: false,
      detail: 'Read only',
      maintenance: { status: 'ok', state: 'healthy', detail: 'Completed' },
    });
    expect((await collectMemoryHealth()).status).toBe('warn');
  });

  it('does not probe disabled memory', async () => {
    memoryProbe.enabled.mockReturnValue(false);
    expect(await collectMemoryHealth()).toMatchObject({
      status: 'ok',
      enabled: false,
      maintenance: { state: 'disabled' },
    });
    expect(memoryProbe.health).not.toHaveBeenCalled();
  });

  it('renders an older host report with unknown maintenance rather than an all-clear', () => {
    const report = fixtureReport();
    delete report.memory.maintenance;
    expect(formatHealthText(report)).toContain('Health: WARN');
    expect(formatHealthMarkdown(report)).toContain('**Health** ⚠️ WARN');
    expect(formatHealthText(report)).toContain('Maintenance status is unavailable from this Luna host.');
  });
});

describe('rollupOverall', () => {
  it('returns ok when all sections are ok or skipped', () => {
    expect(rollupOverall([section('ok'), section('skipped')])).toBe('ok');
  });

  it('returns degraded when any section warns', () => {
    expect(rollupOverall([section('ok'), section('warn')])).toBe('degraded');
  });

  it('returns fail when any section fails', () => {
    expect(rollupOverall([section('warn'), section('fail')])).toBe('fail');
  });
});

describe('formatHealthText', () => {
  it('includes overall status and section lines', () => {
    const text = formatHealthText(fixtureReport());
    expect(text).toContain('Health: OK');
    expect(text).toContain('Service');
    expect(text).toContain('Database');
    expect(text).toContain('Models');
    expect(text).toContain('Memory');
    expect(text).toContain('OneCLI');
    expect(text).toContain('Runtime');
    // Blank-line separated sections (CLI plain text)
    expect(text.split('\n\n').length).toBeGreaterThan(4);
  });

  it('surfaces fail overall and recent errors', () => {
    const text = formatHealthText(
      fixtureReport({
        overall: 'fail',
        onecli: {
          status: 'fail',
          detail: 'unreachable http://127.0.0.1:10254',
          url: 'http://127.0.0.1:10254',
          healthy: false,
        },
        errors: {
          status: 'warn',
          detail: '1 recent error line(s)',
          recent: ['2026-07-23 ERROR boom'],
        },
      }),
    );
    expect(text).toContain('Health: FAIL');
    expect(text).toContain('FAIL  OneCLI');
    expect(text).toContain('ERROR boom');
  });

  it('stays under Telegram message length for large error tails', () => {
    const huge = 'x'.repeat(5000);
    const text = formatHealthText(
      fixtureReport({
        errors: { status: 'warn', detail: 'errors', recent: [huge] },
      }),
    );
    expect(text.length).toBeLessThanOrEqual(3910);
  });
});

describe('formatHealthMarkdown', () => {
  it('renders an emoji table for Telegram', () => {
    const text = formatHealthMarkdown(fixtureReport());
    expect(text).toContain('**Health** ✅ OK');
    expect(text).toContain('| | Check | Detail |');
    expect(text).toContain('|---|---|---|');
    expect(text).toContain('| ✅ | Service |');
    expect(text).toContain('| ✅ | Database |');
    expect(text).toContain('| ✅ | Models |');
    expect(text).toContain('| ✅ | Memory |');
    expect(text).toContain('| ✅ | Builtins |');
    expect(text).toContain('| ✅ | OneCLI |');
    expect(text).toContain('| ✅ | Runtime |');
    expect(text).toContain('| ✅ | Errors |');
    expect(text).toContain('mcp: apple_calendar');
  });

  it('uses warn/fail emojis for degraded sections', () => {
    const text = formatHealthMarkdown(
      fixtureReport({
        overall: 'fail',
        onecli: {
          status: 'fail',
          detail: 'unreachable http://127.0.0.1:10254',
          url: 'http://127.0.0.1:10254',
          healthy: false,
        },
        errors: {
          status: 'warn',
          detail: '1 recent error line(s)',
          recent: ['2026-07-23 ERROR boom'],
        },
      }),
    );
    expect(text).toContain('**Health** ❌ FAIL');
    expect(text).toContain('| ❌ | OneCLI |');
    expect(text).toContain('| ⚠️ | Errors |');
    expect(text).toContain('ERROR boom');
  });

  it('escapes pipes in detail cells', () => {
    const text = formatHealthMarkdown(
      fixtureReport({
        service: {
          status: 'ok',
          detail: 'a | b',
          manager: 'launchd',
          state: 'running',
          pid: 1,
        },
      }),
    );
    expect(text).toContain('| ✅ | Service | a \\| b |');
  });
});

describe('isHealthReport', () => {
  it('accepts a full report fixture', () => {
    expect(isHealthReport(fixtureReport())).toBe(true);
  });

  it('rejects unrelated objects', () => {
    expect(isHealthReport({ overall: 'ok' })).toBe(false);
    expect(isHealthReport(null)).toBe(false);
  });
});
