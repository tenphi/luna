import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  command: vi.fn(),
  close: vi.fn(),
  commands: ['plan'] as string[] | undefined,
  writable: true,
  read: vi.fn(),
}));

vi.mock('./client.js', () => ({
  MemoryUnavailable: class MemoryUnavailable extends Error {},
  retryRead: mock.read,
  isMemoryConnectionLoss: (error: unknown) => error instanceof Error && error.message === 'socket closed',
}));

function status() {
  return {
    activeRuns: 0,
    verificationPending: 0,
    latestRun: { status: 'completed', verification: { status: 'passed' } },
    latestFullRun: { status: 'completed', verification: { status: 'passed' } },
    recovery: { automaticApply: 'available' },
    schedule: { health: 'on_time' },
  };
}

beforeEach(() => {
  vi.resetModules();
  mock.command.mockReset().mockResolvedValue(status());
  mock.close.mockReset();
  mock.commands = ['plan'];
  mock.writable = true;
  mock.read.mockReset().mockImplementation(async (work) =>
    work({
      hello: { commands: mock.commands, writable: mock.writable, akno_path: '/private/invented-brain' },
      command: mock.command,
      close: mock.close,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function health() {
  return (await import('./health.js')).readMemoryHealth();
}

describe('memory maintenance health', () => {
  it('reads only status over the existing host connection', async () => {
    expect(await health()).toMatchObject({
      ok: true,
      writable: true,
      maintenance: { status: 'ok', state: 'healthy', schedule: 'on_time' },
    });
    expect(mock.command).toHaveBeenCalledExactlyOnceWith('plan', { action: 'status', schedule: true });
    expect(mock.close).not.toHaveBeenCalled();
  });

  it.each(['paused', 'partially_paused'])('keeps interactive memory available while %s', async (automaticApply) => {
    mock.command.mockResolvedValue({ ...status(), recovery: { automaticApply } });
    expect(await health()).toMatchObject({
      ok: true,
      writable: true,
      maintenance: {
        status: 'warn',
        state: 'paused',
        automaticApply,
        guidance: expect.stringContaining('akno dream status'),
      },
    });
  });

  it.each(['latestRun', 'latestFullRun'])('reports a failed %s independently of reachability', async (field) => {
    mock.command.mockResolvedValue({ ...status(), [field]: { status: 'failed', verification: null } });
    expect(await health()).toMatchObject({ ok: true, maintenance: { status: 'warn', state: 'failed' } });
  });

  it('keeps a failed full cycle visible while a later successful phase ran', async () => {
    mock.command.mockResolvedValue({
      ...status(),
      latestFullRun: { status: 'failed', verification: { status: 'failed' } },
    });
    expect((await health()).maintenance).toMatchObject({
      state: 'failed',
      latestRun: 'completed',
      latestFullRun: 'failed',
    });
  });

  it('reports a missed cycle only from Akno schedule health', async () => {
    mock.command.mockResolvedValue({ ...status(), schedule: { health: 'overdue' } });
    expect((await health()).maintenance).toMatchObject({ state: 'missed', status: 'warn' });
  });

  it('reports an in-progress cycle without calling it completed', async () => {
    mock.command.mockResolvedValue({
      ...status(),
      activeRuns: 1,
      latestRun: { status: 'running', verification: null },
    });
    expect((await health()).maintenance).toMatchObject({ state: 'running', running: true, status: 'ok' });
  });

  it('does not hide a recovery pause behind a running cycle', async () => {
    mock.command.mockResolvedValue({ ...status(), activeRuns: 1, recovery: { automaticApply: 'paused' } });
    expect((await health()).maintenance).toMatchObject({ state: 'paused', running: true, status: 'warn' });
  });

  it.each(['not_due', 'within_window'])(
    'accepts a first cycle that is %s without claiming it completed',
    async (scheduleHealth) => {
      mock.command.mockResolvedValue({
        ...status(),
        latestRun: null,
        latestFullRun: null,
        schedule: { health: scheduleHealth },
      });
      const result = await health();
      expect(result.maintenance).toMatchObject({ state: 'healthy', latestFullRun: null });
      expect(result.maintenance.detail).not.toContain('completed');
    },
  );

  it.each([
    'not_installed',
    'installed_not_loaded',
    'definition_drift',
    'definition_unknown',
    'invalid_schedule',
    'unsupported',
  ])('warns when scheduler health is %s', async (scheduleHealth) => {
    mock.command.mockResolvedValue({ ...status(), schedule: { health: scheduleHealth } });
    expect((await health()).maintenance).toMatchObject({ state: 'unknown', status: 'warn' });
  });

  it('reports older schedule capability as unknown while retaining known pauses', async () => {
    mock.command.mockResolvedValue({ ...status(), schedule: undefined });
    expect((await health()).maintenance).toMatchObject({ state: 'unknown', schedule: 'unknown' });
    mock.command.mockResolvedValue({ ...status(), schedule: undefined, recovery: { automaticApply: 'paused' } });
    expect((await health()).maintenance).toMatchObject({ state: 'paused', schedule: 'unknown' });
  });

  it('keeps a known pause and its reason when the schedule adds an unfamiliar state', async () => {
    mock.command.mockResolvedValue({
      ...status(),
      schedule: { health: 'future-value' },
      recovery: { automaticApply: 'paused', profile: { reason: 'verification_unproven' } },
    });
    expect((await health()).maintenance).toMatchObject({
      state: 'paused',
      schedule: 'unknown',
      detail: expect.stringContaining('verification could not prove a safe result'),
    });
  });

  it.each(['incomplete', 'unavailable', 'future-value'])(
    'does not treat %s verification as success',
    async (verification) => {
      mock.command.mockResolvedValue({
        ...status(),
        latestFullRun: { status: 'completed', verification: { status: verification } },
      });
      expect((await health()).maintenance).toMatchObject({ status: 'warn', state: 'unknown' });
    },
  );

  it('does not lose a schedule warning while a manual cycle is running', async () => {
    mock.command.mockResolvedValue({ ...status(), activeRuns: 1, schedule: undefined });
    expect((await health()).maintenance).toMatchObject({ state: 'running', status: 'warn', schedule: 'unknown' });
  });

  it('keeps an unfinished full run visible after a completed phase', async () => {
    mock.command.mockResolvedValue({ ...status(), latestFullRun: { status: 'running', verification: null } });
    expect((await health()).maintenance).toMatchObject({ state: 'running', running: true });
  });

  it('bounds an initial connection attempt too', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    mock.read.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const { readMemoryHealth } = await import('./health.js');
    const pending = readMemoryHealth();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ ok: false, writable: false, maintenance: { state: 'unavailable' } });
    reject(new Error('socket closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.command).not.toHaveBeenCalled();
    expect(mock.close).not.toHaveBeenCalled();
  });

  it('does not call an operator command that an older service does not advertise', async () => {
    mock.commands = undefined;
    expect(await health()).toMatchObject({ ok: true, maintenance: { state: 'unknown' } });
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('reports status rejection as unavailable without exposing the backend message', async () => {
    mock.command.mockRejectedValue(new Error('Private receipt at /private/invented-brain/case.md'));
    const result = await health();
    expect(result).toMatchObject({ ok: true, writable: true, maintenance: { state: 'unavailable' } });
    expect(JSON.stringify(result)).not.toContain('Private receipt');
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('reports an unavailable connection separately', async () => {
    mock.read.mockRejectedValue(new Error('socket closed'));
    expect(await health()).toMatchObject({
      ok: false,
      writable: false,
      detail: 'Memory connection is unavailable.',
      maintenance: { state: 'unavailable' },
    });
    expect(mock.command).not.toHaveBeenCalled();
  });

  it('names the Akno version it connected to', async () => {
    mock.read.mockImplementation(async (work) =>
      work({ hello: { commands: ['plan'], writable: true, version: '0.22.0' }, command: mock.command }),
    );
    expect((await health()).detail).toBe('Connected to Akno 0.22.0; memory reads and writes are available.');
  });

  it('says which side to upgrade when Akno refuses the protocol, without the socket path', async () => {
    const { MemoryUnavailable } = await import('./client.js');
    mock.read.mockRejectedValue(
      new MemoryUnavailable(
        'no memory service at /private/invented/akno.sock: Akno version mismatch: client speaks protocol 5, ' +
          'server speaks 6. Upgrade one of them.',
      ),
    );
    const result = await health();
    expect(result).toMatchObject({
      ok: false,
      detail:
        'Akno version mismatch: client speaks protocol 5, server speaks 6. Upgrade Luna or Akno so both speak the same protocol.',
    });
    expect(JSON.stringify(result)).not.toContain('/private');
  });

  it('keeps read-only connection status separate from healthy maintenance', async () => {
    mock.writable = false;
    expect(await health()).toMatchObject({ ok: true, writable: false, maintenance: { state: 'healthy' } });
  });

  it.each([{}, null, { ...status(), recovery: undefined }, { ...status(), latestFullRun: null }])(
    'does not call incomplete status healthy (%j)',
    async (input) => {
      mock.command.mockResolvedValue(input);
      expect((await health()).maintenance).toMatchObject({ state: 'unknown', status: 'warn' });
    },
  );

  it('never exposes private receipts, hints, prompts, or recovery commands', async () => {
    const privateText = 'Private invented compass notes';
    mock.command.mockResolvedValue({
      ...status(),
      latestRun: { ...status().latestRun, summary: privateText, paths: ['/private/case.md'] },
      pendingPlans: [{ prompt: privateText, diff: privateText }],
      recovery: { automaticApply: 'paused', profile: { recoveryCommand: privateText } },
    });
    const output = JSON.stringify(await health());
    expect(output).not.toContain(privateText);
    expect(output).not.toContain('/private');
    expect(output).not.toContain('pendingPlans');
  });

  it('bounds repeated waits without closing the shared connection or accumulating reads', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mock.command.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { readMemoryHealth } = await import('./health.js');
    const first = readMemoryHealth();
    const concurrent = readMemoryHealth();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toMatchObject({
      ok: true,
      maintenance: { state: 'unavailable', detail: expect.stringContaining('timed out') },
    });
    expect(await concurrent).toEqual(await first);
    const second = readMemoryHealth();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await second).maintenance.state).toBe('unavailable');
    expect(mock.command).toHaveBeenCalledTimes(1);
    expect(mock.close).not.toHaveBeenCalled();
    resolve(status());
    await vi.advanceTimersByTimeAsync(0);
    mock.command.mockResolvedValue(status());
    expect((await readMemoryHealth()).maintenance.state).toBe('healthy');
    expect(mock.command).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
