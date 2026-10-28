/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * `inReplyTo` is the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * The poll loop owns the process-level defaults. Luna's MCP tools run in a
 * separate process, so the bridge carries a snapshot in request metadata and
 * the server scopes it to that call. Overlapping calls must not share globals.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const batchSchema = z.object({
  inReplyTo: z.string().nullable(),
  taskRun: z.object({
    seriesId: z.string(),
    runId: z.string(),
    scheduledFor: z.string(),
    prompt: z.string(),
    recurrence: z.string().nullable(),
  }).nullable(),
});
type BatchContext = z.infer<typeof batchSchema>;
const requestBatch = new AsyncLocalStorage<BatchContext>();
const BATCH_META_KEY = 'luna/batch';

let currentInReplyTo: string | null = null;
let currentTaskRun: BatchContext['taskRun'] = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  const scoped = requestBatch.getStore();
  return scoped ? scoped.inReplyTo : currentInReplyTo;
}

export function setCurrentTaskRun(
  run: BatchContext['taskRun'],
): void {
  currentTaskRun = run;
}

export function getCurrentTaskRun(): typeof currentTaskRun {
  const scoped = requestBatch.getStore();
  return scoped ? scoped.taskRun : currentTaskRun;
}

/** Private transport context, never model arguments or metadata for external servers. */
export function currentBatchMeta(server: string): Record<string, unknown> | undefined {
  if (server !== 'luna') return undefined;
  return { [BATCH_META_KEY]: { inReplyTo: getCurrentInReplyTo(), taskRun: getCurrentTaskRun() } };
}

export function withMcpBatch<T>(meta: Record<string, unknown> | undefined, run: () => T): T {
  const parsed = batchSchema.safeParse(meta?.[BATCH_META_KEY]);
  if (!parsed.success && meta?.[BATCH_META_KEY] !== undefined) throw new Error('Invalid Luna batch metadata');
  return requestBatch.run(parsed.success ? parsed.data : { inReplyTo: null, taskRun: null }, run);
}
