import { z } from 'zod';

import { isMemoryConnectionLoss, MemoryUnavailable, retryRead } from './client.js';

export interface MemoryMaintenanceHealth {
  status: 'ok' | 'warn' | 'skipped';
  state: 'healthy' | 'paused' | 'failed' | 'missed' | 'running' | 'unknown' | 'unavailable' | 'disabled';
  detail: string;
  guidance?: string;
  automaticApply?: 'available' | 'partially_paused' | 'paused';
  running?: boolean;
  latestRun?: 'running' | 'completed' | 'failed' | null;
  latestFullRun?: 'running' | 'completed' | 'failed' | null;
  schedule?: string;
}

export interface MemoryServiceHealth {
  ok: boolean;
  writable: boolean;
  detail: string;
  maintenance: MemoryMaintenanceHealth;
}

const HEALTH_TIMEOUT_MS = 2_000;
const INSPECT = 'Inspect with `akno dream status`; review affected plans before manually resuming maintenance.';
const Run = z.object({
  status: z.enum(['running', 'completed', 'failed']),
  verification: z
    .object({ status: z.enum(['passed', 'failed', 'incomplete', 'unavailable']).catch('unavailable') })
    .nullish(),
});
const Status = z.object({
  activeRuns: z.number().int().nonnegative(),
  verificationPending: z.number().int().nonnegative(),
  latestRun: Run.nullable(),
  latestFullRun: Run.nullable(),
  recovery: z.object({
    automaticApply: z.enum(['available', 'partially_paused', 'paused']),
    profile: z
      .object({
        reason: z
          .enum([
            'live_bytes_uncertain',
            'plan_store_unavailable',
            'journal_receipt_missing',
            'verification_unproven',
            'rollback_threshold',
            'unknown',
          ])
          .catch('unknown'),
      })
      .nullish(),
  }),
  schedule: z
    .object({
      health: z
        .enum([
          'unsupported',
          'not_installed',
          'installed_not_loaded',
          'definition_drift',
          'definition_unknown',
          'invalid_schedule',
          'not_due',
          'within_window',
          'running',
          'on_time',
          'last_run_failed',
          'overdue',
          'unknown',
        ])
        .catch('unknown'),
    })
    .catch({ health: 'unknown' })
    .optional(),
});

function unknown(state: 'unknown' | 'unavailable', detail: string): MemoryMaintenanceHealth {
  return { status: 'warn', state, detail, guidance: INSPECT };
}

/** Only allowlisted state crosses into health output; receipts can contain private page identities. */
function summarize(input: unknown): MemoryMaintenanceHealth {
  const parsed = Status.safeParse(input);
  if (!parsed.success) return unknown('unknown', 'Maintenance status is not understood by this Luna version.');
  const status = parsed.data;
  const schedule = status.schedule?.health ?? 'unknown';
  const running =
    status.activeRuns > 0 ||
    status.latestRun?.status === 'running' ||
    status.latestFullRun?.status === 'running' ||
    schedule === 'running';
  const base = {
    automaticApply: status.recovery.automaticApply,
    running,
    latestRun: status.latestRun?.status ?? null,
    latestFullRun: status.latestFullRun?.status ?? null,
    schedule,
  };
  const result = (
    state: MemoryMaintenanceHealth['state'],
    detail: string,
    warning = true,
  ): MemoryMaintenanceHealth => ({
    ...base,
    status: warning ? 'warn' : 'ok',
    state,
    detail,
    ...(warning ? { guidance: INSPECT } : {}),
  });
  if (status.recovery.automaticApply !== 'available') {
    const reason = status.recovery.profile?.reason;
    const reasons = {
      live_bytes_uncertain: 'the state of written files could not be confirmed',
      plan_store_unavailable: 'maintenance plan storage is unavailable',
      journal_receipt_missing: 'a change receipt is missing',
      verification_unproven: 'verification could not prove a safe result',
      rollback_threshold: 'repeated writes had to be rolled back',
      unknown: 'recovery needs inspection',
    };
    return result(
      'paused',
      status.recovery.automaticApply === 'paused'
        ? `Automatic maintenance is paused: ${reasons[reason ?? 'unknown']}.`
        : 'Some automatic maintenance is paused pending recovery.',
    );
  }
  if (
    [status.latestRun, status.latestFullRun].some(
      (run) => run?.status === 'failed' || run?.verification?.status === 'failed',
    ) ||
    schedule === 'last_run_failed'
  ) {
    return result(
      'failed',
      `The latest maintenance run failed verification or execution.${running ? ' A run is in progress.' : ''}`,
    );
  }
  if (schedule === 'overdue') return result('missed', 'The scheduled maintenance cycle is overdue.');
  if (status.verificationPending > 0) return result('unknown', 'Maintenance is waiting for verification.');
  const scheduleProblems: Partial<Record<typeof schedule, string>> = {
    unknown: 'Schedule health is unavailable from this Akno version.',
    unsupported: 'Schedule health is unavailable on this Akno service.',
    not_installed: 'Nightly maintenance is not scheduled.',
    installed_not_loaded: 'The maintenance schedule is installed but not loaded.',
    definition_drift: 'The loaded maintenance schedule differs from its definition.',
    definition_unknown: 'The loaded maintenance schedule could not be verified.',
    invalid_schedule: 'The maintenance schedule is unreadable.',
  };
  const scheduleProblem = scheduleProblems[schedule];
  if (running)
    return result(
      'running',
      `Maintenance is in progress.${scheduleProblem ? ` ${scheduleProblem}` : ''}`,
      Boolean(scheduleProblem),
    );
  if (scheduleProblem) return result('unknown', scheduleProblem);
  if (
    [status.latestRun, status.latestFullRun].some(
      (run) => run?.status === 'completed' && run.verification?.status !== 'passed',
    )
  ) {
    return result('unknown', 'A completed maintenance run has no confirmed verification result.');
  }
  if (schedule === 'on_time' && !status.latestFullRun) {
    return result('unknown', 'The schedule reports success without a full-cycle receipt.');
  }
  return result(
    'healthy',
    schedule === 'on_time'
      ? 'The scheduled maintenance cycle completed.'
      : 'Maintenance is within its scheduled window.',
    false,
  );
}

interface Probe {
  connection: Pick<MemoryServiceHealth, 'ok' | 'writable' | 'detail'>;
  result: Promise<MemoryServiceHealth>;
}

let inFlight: Probe | null = null;

function startProbe(): Probe {
  const connection = { ok: false, writable: false, detail: 'Memory connection is unavailable.' };
  const result = retryRead(async (client) => {
    Object.assign(connection, {
      ok: true,
      writable: client.hello.writable,
      detail: client.hello.writable
        ? 'Connected; memory reads and writes are available.'
        : 'Connected; memory is read-only.',
    });
    if (!client.hello.commands?.includes('plan')) {
      return {
        ...connection,
        maintenance: unknown('unknown', 'This Akno service does not advertise maintenance status.'),
      };
    }
    const status = await client.command('plan', { action: 'status', schedule: true });
    return { ...connection, maintenance: summarize(status) };
  })
    .catch((error: unknown) => {
      if (isMemoryConnectionLoss(error) || error instanceof MemoryUnavailable) {
        Object.assign(connection, { ok: false, writable: false, detail: 'Memory connection is unavailable.' });
      }
      return { ...connection, maintenance: unknown('unavailable', 'Maintenance status could not be read.') };
    })
    .finally(() => {
      if (inFlight?.result === result) inFlight = null;
    });
  return { connection, result };
}

/**
 * Bound the owner's wait without closing the shared connection underneath a retention write.
 * Keep one underlying read in flight after a timeout so repeated health checks cannot pile up.
 */
export async function readMemoryHealth(): Promise<MemoryServiceHealth> {
  inFlight ??= startProbe();
  const probe = inFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe.result,
      new Promise<MemoryServiceHealth>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ...probe.connection,
              maintenance: unknown('unavailable', 'Maintenance status timed out.'),
            }),
          HEALTH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
