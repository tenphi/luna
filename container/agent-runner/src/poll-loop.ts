import { randomUUID } from 'node:crypto';
import {
  findByName,
  getAllDestinations,
  makeRoutingResolver,
  resolveReplyDestination,
  type DestinationEntry,
} from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { EMPTY_ANSWER_FALLBACK } from './reply-contract.js';
import { writeStatusMessage } from './status-out.js';
import { touchHeartbeat } from './db/connection.js';
import { getSessionClient } from './session/client.js';
import { formatMemoryEdits, readMemoryEditContext } from './memory-edit-context.js';
import {
  clearContinuation,
  clearTaskContinuation,
  getContinuation,
  getTaskContinuation,
  setContinuation,
  setTaskContinuation,
} from './db/session-state.js';
import { clearCurrentInReplyTo, getCurrentTaskRun, setCurrentInReplyTo, setCurrentTaskRun } from './current-batch.js';
import { loadConfig } from './config.js';
import {
  formatMessagesWithMedia,
  extractReplyEvidence,
  extractRouting,
  extractUserText,
  categorizeMessage,
  isRunnerCommand,
  setOriginResolver,
  stripInternalTags,
  type FormattedPrompt,
  type RoutingContext,
} from './formatter.js';
import {
  EMPTY_INTAKE,
  resolveAttachmentsConfig,
  runAttachmentIntake,
  type AttachmentIntake,
} from './attachment-digest.js';
import {
  executeRunnerCommand,
  parseRunnerCommand,
  runnerCommandMessages,
  runnerOutboundContent,
} from './session-commands.js';
import { formatProviderError, logProviderError } from './providers/format-error.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import type { McpBridge } from './providers/openai/tools/mcp-bridge.js';
import { relativeWhen } from './providers/openai/episodes/format.js';
import { drainConversationMirrors, mirrorEpisodeToMemory } from './providers/openai/episodes/mirror.js';
import { drainEpisodeSummaries, isSummaryHost } from './providers/openai/episodes/summarize.js';
import {
  appendMemoryChange,
  isMutatingMemoryTool,
  mutatedSlug,
  mutationAction,
} from './providers/openai/tools/memory-mutations.js';

const DEFAULT_OPENAI_BASE_URL = 'http://localhost:8080/v1';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${randomUUID()}`;
}

/** Never mix a scheduled occurrence with chat or another scheduled occurrence. */
export function selectExecutionBatch(messages: MessageInRow[]): MessageInRow[] {
  const firstTrigger = messages.findIndex((message) => message.trigger === 1);
  if (firstTrigger < 0) return messages;
  if (messages[firstTrigger]?.kind === 'task') return [messages[firstTrigger]!];
  const nextTask = messages.findIndex((message, index) => index > firstTrigger && message.kind === 'task');
  return nextTask < 0 ? messages : messages.slice(0, nextTask);
}

// --- Background episode-summary drain (single-flight + trailing rerun) ----
//
// Summarizing must never block the next user turn. After a query finishes we kick a background
// drain; if another turn finishes while draining, `episodeDrainRerun` makes the loop run once more.
//
// This hook used to carry a second passenger: a queue of `fact_extraction_jobs` feeding a hidden
// "memory agent" that curated each turn into pages of its own. That component is gone — memory
// decides what lasts now, and the host's own digest hands it the turn — so what is left is the
// episode summaries, which is why the deferral policy below is still worth its complexity.

let episodeDrainInFlight: Promise<void> | null = null;
let episodeDrainRerun = false;

/**
 * How long the conversation must stay quiet before the drain starts.
 *
 * "Never blocks the next user turn" was true of the *event loop* and false of the thing that
 * actually matters: the memory service. Akno's embedding model and reranker each run one slot,
 * and a background writer holds both for a long time — measured 11.7s, 13.3s, 15.3s, 17.1s and
 * 23.6s in one afternoon. The next turn's pre-turn recall queues behind that and dies on its own
 * budget, which is why memory looked "unavailable" precisely when someone was talking quickly:
 * every reply kicked a writer that outlived the gap before the next question.
 *
 * So the drain waits for a gap instead of racing into one. Nothing is lost by waiting — an episode
 * needing a summary keeps needing one, and the next turn re-arms this timer.
 */
const EPISODE_DRAIN_QUIET_MS = 8_000;
/**
 * ...but a conversation that never pauses must not defer summaries forever. Past this, the drain
 * runs on the next opportunity.
 */
const EPISODE_DRAIN_MAX_DEFER_MS = 90_000;
let episodeDrainQuietTimer: ReturnType<typeof setTimeout> | null = null;
let episodeDrainDeferredSince: number | null = null;

/**
 * Wait for a gap, or run now? Returns the delay in ms, or `null` to run immediately.
 *
 * Pure so the policy can be tested without a provider or real timers — and because the exemption
 * is easy to get subtly wrong. `isDeferred` has to be its own flag rather than a falsy sentinel on
 * a counter: folding it together with one makes the timer re-arm itself forever and the drain never
 * runs.
 */
export function episodeDrainDelayMs(input: {
  now: number;
  /** When the current run of deferrals began, or null if this is the first. */
  deferredSince: number | null;
  /** The quiet timer just fired for this payload; waiting again would be the same wait twice. */
  isDeferred: boolean;
  quietMs?: number;
  maxDeferMs?: number;
}): number | null {
  if (input.isDeferred) return null;
  const maxDefer = input.maxDeferMs ?? EPISODE_DRAIN_MAX_DEFER_MS;
  const since = input.deferredSince ?? input.now;
  if (input.now - since >= maxDefer) return null;
  return input.quietMs ?? EPISODE_DRAIN_QUIET_MS;
}

function scheduleEpisodeSummaryDrain(opts: { provider: AgentProvider; deferred?: boolean }): void {
  if (episodeDrainInFlight) {
    episodeDrainRerun = true;
    return;
  }

  // Hold for a gap in the conversation. A run the quiet timer already waited for is exempt —
  // waiting twice would be the same delay twice.
  {
    const now = Date.now();
    if (!opts.deferred) {
      episodeDrainDeferredSince ??= now;
      if (episodeDrainQuietTimer) clearTimeout(episodeDrainQuietTimer);
    }
    const delay = episodeDrainDelayMs({
      now,
      deferredSince: episodeDrainDeferredSince,
      isDeferred: Boolean(opts.deferred),
    });
    if (delay !== null) {
      episodeDrainQuietTimer = setTimeout(() => {
        episodeDrainQuietTimer = null;
        episodeDrainDeferredSince = null;
        scheduleEpisodeSummaryDrain({ ...opts, deferred: true });
      }, delay);
      episodeDrainQuietTimer.unref?.();
      return;
    }
    if (!opts.deferred && episodeDrainDeferredSince !== null) {
      log(
        `Episode summaries deferred ${Math.round((now - episodeDrainDeferredSince) / 1000)}s by a busy conversation — running now`,
      );
    }
    episodeDrainDeferredSince = null;
  }

  const provider = opts.provider;

  const run = async (): Promise<void> => {
    let again = true;
    while (again) {
      again = false;
      episodeDrainRerun = false;
      try {
        // Summaries may run on the main model, which only this provider can reach.
        const host = isSummaryHost(provider) ? provider : null;
        const n = await drainEpisodeSummaries({
          host,
          // The bridge is resolved per summary rather than up front: connecting
          // MCP is idempotent but not free, and most passes summarize nothing.
          onSummarized: async (episode, summary) => {
            const bridge = (await provider.ensureToolBridge?.()) ?? null;
            await mirrorEpisodeToMemory(bridge, episode, summary);
          },
        });
        if (n > 0) log(`Summarized ${n} closed episode(s)`);

        // Catch up any episode that has a summary but no page — a mirror that
        // failed once is otherwise never retried, since `summarizedAt` is set.
        const mirrored = await drainConversationMirrors(async () => (await provider.ensureToolBridge?.()) ?? null);
        if (mirrored > 0) log(`Mirrored ${mirrored} conversation page(s)`);
      } catch (err) {
        log(`Episode summary drain failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      again = episodeDrainRerun;
    }
  };

  episodeDrainInFlight = run().finally(() => {
    episodeDrainInFlight = null;
    // Race: a schedule may have landed between loop exit and this finally.
    if (episodeDrainRerun) {
      episodeDrainRerun = false;
      scheduleEpisodeSummaryDrain({ provider });
    }
  });
}

/**
 * Refresh the formatter's synchronous origin resolver from a single
 * destination snapshot. Called before each formatting pass so the sync
 * `from="name"` attribution doesn't need to await per-message lookups.
 */
async function refreshOriginResolver(): Promise<void> {
  try {
    setOriginResolver(makeRoutingResolver(await getAllDestinations()));
  } catch {
    // Best-effort — keep the previous snapshot (or the "unknown" default).
  }
}

export type PollLoopConfig = {
  provider: AgentProvider;
  providerName: string;
  cwd: string;
  systemContext?: { instructions?: string };
  signal?: AbortSignal;
};

/** Stream host-owned session turns through a provider, then acknowledge completed input. */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Continuations belong to the provider that created them.
  let continuation: string | undefined = await getContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling.
  if (continuation) {
    const rotateReason = await config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      await clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  let pollCount = 0;
  let isFirstPoll = true;
  while (!config.signal?.aborted) {
    try {
      // Skip system messages — they're host-written control rows (e.g. question_response
      // for an approval card), not turns for the agent to answer.
      const messages = selectExecutionBatch((await getPendingMessages(isFirstPoll)).filter((m) => m.kind !== 'system'));
      isFirstPoll = false;
      pollCount++;

      // Periodic heartbeat so we know the loop is alive
      if (pollCount % 30 === 0) {
        log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
      }

      if (messages.length === 0) {
        touchHeartbeat();
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Keep silent context pending until a triggered message arrives.
      if (!messages.some((m) => m.trigger === 1)) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const ids = messages.map((m) => m.id);
      await markProcessing(ids);

      const routing = extractRouting(messages);

      // Command handling: the host router gates filtered and unauthorized
      // admin commands before they reach the container. Runner-handled commands
      // (session: /clear /compact /context /usage /files /stop /learn /topics;
      // knowledge base: /read /raw /download /list /recall /query /forget
      // /delete /restore) execute here.
      const normalMessages: MessageInRow[] = [];
      const commandIds: string[] = [];

      for (const msg of messages) {
        const command = parseRunnerCommand(msg);
        if (command) {
          log(`Runner command: ${command}`);
          const reply = await executeRunnerCommand(
            command,
            {
              providerName: config.providerName,
              continuation,
              contextConfig: loadConfig().context,
              episodesEnabled: routing.episodesEnabled,
            },
            msg,
          );
          if (command === '/clear' || command === '/stop') {
            if (command === '/clear') {
              continuation = undefined;
            }
            await emitStatusNow(routing, { phase: 'done' });
          }
          // A command may answer with several rows: /read splits a long page, and
          // /download needs one row per file because Telegram refuses more than
          // one upload per message. Per-session delivery is serialized, so write
          // order is delivery order.
          for (const out of runnerCommandMessages(reply)) {
            await writeMessageOut({
              // A row carrying files must keep the id its bytes were staged
              // under — the host reads them from outbox/<row id>/.
              id: out.id ?? generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: runnerOutboundContent(out),
            });
          }
          commandIds.push(msg.id);
          continue;
        }
        normalMessages.push(msg);
      }

      if (commandIds.length > 0) {
        await markCompleted(commandIds);
      }

      if (!normalMessages.length) {
        const commands = new Set(commandIds);
        await markCompleted(ids.filter((id) => !commands.has(id)));
        log('Command batch handled by the runtime');
        continue;
      }

      const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
      const { keep, skipped } = await applyPreTaskScripts(normalMessages);
      if (skipped.length > 0) {
        await markCompleted(skipped);
        log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
      }

      if (keep.length === 0) {
        log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
        continue;
      }

      // Format messages: passthrough commands get raw text (only if the
      // provider natively handles slash commands), others get XML.
      await refreshOriginResolver();
      const formatted = formatMessagesWithMedia(keep);

      // Read any attached files BEFORE the provider decides what this turn is
      // about. The topic classifier and the recall query are both text-only, so
      // without this a caption-less PDF reaches them as a filename and the turn
      // stays on whatever the last topic was. No attachments ⇒ no cost at all.
      const intake = await runIntake(keep);

      log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

      const task = keep.length === 1 && keep[0]?.kind === 'task' ? keep[0] : null;
      const taskContent = task ? (JSON.parse(task.content) as { prompt?: string }) : null;
      const taskRun = task
        ? {
            seriesId: task.series_id ?? task.id,
            runId: task.id,
            scheduledFor: task.process_after ?? task.timestamp,
            prompt: taskContent?.prompt ?? '',
            recurrence: task.recurrence,
          }
        : undefined;
      const runContinuation = taskRun ? await getTaskContinuation(config.providerName, taskRun.runId) : continuation;

      const memoryEdits = await readMemoryEditContext();
      const memoryContext = formatMemoryEdits(memoryEdits);
      const query = config.provider.query({
        prompt: [memoryContext, formatted.prompt, intake.block].filter(Boolean).join('\n\n'),
        topicText: extractUserText(keep),
        attachments: intake.evidence,
        replyTo: extractReplyEvidence(keep),
        images: formatted.images.length > 0 ? formatted.images : undefined,
        continuation: runContinuation,
        taskRun,
        cwd: config.cwd,
        systemContext: config.systemContext,
        senderIsPrivileged: routing.senderIsPrivileged,
        hotMemorySlug: routing.hotMemorySlug,
        episodesEnabled: taskRun ? false : routing.episodesEnabled,
      });

      // Process the query while concurrently polling for new messages
      const skippedSet = new Set(skipped);
      const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
      // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
      // can stamp it on outbound rows — needed for a2a return-path routing.
      // A scheduled report may have no conversation anchor. Its run id is still the source
      // identity, and explicit send_message calls must carry it so the host digests the actual
      // report instead of only the later "sent" acknowledgement.
      setCurrentInReplyTo(taskRun?.runId ?? routing.inReplyTo);
      setCurrentTaskRun(taskRun ?? null);
      try {
        const result = await processQuery(
          query,
          routing,
          processingIds,
          config.providerName,
          config.provider,
          config.signal,
          taskRun?.runId,
          memoryEdits.map((edit) => edit.id),
        );
        if (!taskRun && result.continuation && result.continuation !== continuation) {
          continuation = result.continuation;
          await setContinuation(config.providerName, continuation);
        }
      } catch (err) {
        // Last resort: the provider threw instead of closing the turn with a
        // result. A well-behaved provider handles its own errors, so this path
        // is for bugs and abrupt stream failures.
        logProviderError(err);
        const errMsg = formatProviderError(
          err,
          { baseURL: process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL, model: process.env.OPENAI_MODEL },
          { detailed: routing.senderIsPrivileged },
        );
        log(`Query error: ${errMsg}`);

        // Stale/corrupt continuation recovery: ask the provider whether
        // this error means the stored continuation is unusable, and clear
        // it so the next attempt starts fresh.
        if (runContinuation && config.provider.isSessionInvalid(err)) {
          log(`Stale session detected (${runContinuation}) — clearing for next retry`);
          if (taskRun) await clearTaskContinuation(config.providerName, taskRun.runId);
          else {
            continuation = undefined;
            await clearContinuation(config.providerName);
          }
        }

        await emitStatusNow(routing, { phase: 'done' });

        // Write error response so the user knows something went wrong. Sent as
        // written by formatProviderError — no "Error:" prefix, which is the
        // model-facing tool-result convention, not how Luna talks to a person.
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: errMsg }),
        });
      } finally {
        clearCurrentInReplyTo();
        setCurrentTaskRun(null);
      }

      // Ensure completed even if processQuery ended without a result event
      // (e.g. stream closed unexpectedly).
      await markCompleted(processingIds);
      log(`Completed ${ids.length} message(s)`);
    } catch (err) {
      // A Session API failure must not end the process. The client already
      // retried a transient blip, so reaching here means the host is down or
      // restarting — which resolves on its own. Exiting instead stranded every
      // message this iteration had claimed in `processing` until the host sweep
      // noticed, and threw away the agent session with it.
      //
      // isFirstPoll is only cleared after a successful poll, so a wake message
      // is still delivered to the next attempt.
      log(`Poll iteration failed, retrying: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/**
 * Digest a batch's attachments, never failing the turn.
 *
 * Wrapped rather than trusted: this stage shells out and may call a model, and
 * `runAttachmentIntake` already swallows per-file failures — this catches the
 * ones that escape it (a config surprise, a full disk) so a broken digest costs
 * the turn its extra context and nothing more.
 */
async function runIntake(messages: MessageInRow[]): Promise<AttachmentIntake> {
  try {
    return await runAttachmentIntake(messages, resolveAttachmentsConfig(loadConfig().context?.attachments));
  } catch (err) {
    log(`Attachment intake failed: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_INTAKE;
  }
}

interface QueryResult {
  continuation?: string;
  /** Final assistant reply text from the last result event (for fact extraction). */
  assistantReply?: string | null;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  provider: AgentProvider,
  signal?: AbortSignal,
  taskRunId?: string,
  memoryEditIds: string[] = [],
): Promise<QueryResult> {
  // Wind the turn down on abort. Without this the `for await` below parks on
  // the provider's open stream indefinitely — the query stays open waiting for
  // follow-up pushes, so nothing ever ends it.
  const endOnAbort = () => query.end();
  signal?.addEventListener('abort', endOnAbort, { once: true });

  let queryContinuation: string | undefined;
  let done = false;
  let sawResult = false;
  let assistantReply: string | null = null;
  // Per-turn tracking for skip-when-inline. Reset on each result (a query may span
  // multiple turns via follow-up pushes).
  let mainAgentTouchedMemory = false;
  let turnToolCalls: string[] = [];
  // Full assistant answer for the turn — the model may split it across several
  // `interim` messages (prose before tool calls) plus the final `result` text.
  // Accumulate every piece so the memory agent sees the complete answer.
  let turnReplyParts: string[] = [];
  /** Inbound ids awaiting the next result (initial batch, then each follow-up push). */
  let pendingTurnIds = [...initialBatchIds];
  let activeRouting = routing;

  // Resolve the status destination for the turn. Every phase/tool/progress row
  // reuses it, so a status write is a single HTTP round-trip instead of three
  // (destinations + thread + write). Re-anchored below when a new user-triggered
  // follow-up is pushed into this still-open query, so the host starts a fresh
  // process message instead of editing the previous turn's bubble.
  let statusTarget = await resolveStatusTarget(routing);
  let turnReasoningEffort: string | undefined;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess and re-loading the transcript on every turn.
  // Stream liveness is decided host-side via the liveness ping + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // kills the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = await getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id; admin/passthrough commands only dispatch when they're
        // the first input of a query. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }
        if (pending.some((m) => m.kind === 'task')) {
          log('Pending scheduled run — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        if (taskRunId) return;

        // Skip system messages (MCP tool responses). Thread routing is the
        // router's concern — if a message landed in this session, the agent
        // should see it.
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        await markProcessing(newIds);

        // Run pre-task scripts on follow-ups too.
        let keep = newMessages;
        let skipped: string[] = [];
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          await markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        await refreshOriginResolver();
        const followUp = formatMessagesWithMedia(keep);
        // A steering push is a fresh user turn once the current one finishes, so
        // its attachments get the same pre-read as a batch's.
        const followIntake = await runIntake(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        // Close the claim BEFORE handing the content to the model, the same
        // order the terminal-result path uses. If markCompleted fails after the
        // push, the model answers a message that is still `processing`, the host
        // sweep resets it on the next container kill, and the user gets the same
        // answer twice. Failing here instead leaves it unanswered, which the
        // replay then handles correctly. `push` is a synchronous in-memory
        // enqueue, so there is no matching window on this side.
        const followEdits = (await readMemoryEditContext()).filter((edit) => !memoryEditIds.includes(edit.id));
        if (done) return;
        await markCompleted(keptIds);
        query.push(
          [formatMemoryEdits(followEdits), followUp.prompt, followIntake.block].filter(Boolean).join('\n\n'),
          followUp.images.length > 0 ? followUp.images : undefined,
          extractUserText(keep),
          followIntake.evidence,
          extractReplyEvidence(keep),
        );
        // Follow-ups use the existing synchronous enqueue handoff, like their inbound messages.
        await getSessionClient().acknowledgeMemoryEdits(followEdits.map((edit) => edit.id));
        pendingTurnIds = keptIds;

        // A real user-triggered follow-up starts a new progress turn. Re-anchor
        // the status target to this follow-up's inbound message so the host
        // finalizes the previous bubble and opens a fresh one — otherwise the
        // previous process message "jumps" to the new answer.
        if (keep.some((m) => m.trigger === 1)) {
          const followRouting = extractRouting(keep);
          activeRouting = followRouting;
          setCurrentInReplyTo(followRouting.inReplyTo);
          const reAnchored = await resolveStatusTarget(followRouting);
          if (reAnchored) statusTarget = reAnchored;
        }
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. Transport hiccups
        // are transient (the SessionClient already retries); log and move on.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation.
        if (taskRunId) await setTaskContinuation(providerName, taskRunId, event.continuation);
        else await setContinuation(providerName, event.continuation);
      } else if (event.type === 'topic') {
        await writeTopicDivider(event, routing);
      } else if (event.type === 'phase') {
        const payload: Record<string, unknown> = { phase: event.phase };
        if (typeof event.text === 'string') payload.text = event.text;
        emitStatus(statusTarget, payload);
      } else if (event.type === 'effort') {
        turnReasoningEffort = event.effort;
        emitStatus(statusTarget, { phase: 'effort', effort: event.effort });
      } else if (event.type === 'tool_compose') {
        emitStatus(statusTarget, { phase: 'tool', name: event.name, index: event.index, partial: true });
      } else if (event.type === 'tool') {
        if (isMutatingMemoryTool(event.name)) {
          mainAgentTouchedMemory = true;
          // Recorded so the episode knows which pages it touched. `isTrivialEpisode` reads that to
          // decide whether a topic was worth announcing, and with nothing writing the journal every
          // short topic looked trivial — which is why the topic divider stopped appearing. The
          // previous backend wrote this from inside its own tool dispatch; memory's tools are
          // relayed now, so the loop that already sees every tool call records it instead.
          const slug = mutatedSlug(event.args as Record<string, unknown> | undefined);
          if (slug) {
            void appendMemoryChange({
              id: generateId(),
              action: mutationAction(event.name),
              kind: 'page',
              slug,
              before: null,
              status: 'applied',
              at: new Date().toISOString(),
            }).catch((err: unknown) => {
              log(`Memory change record failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
        turnToolCalls.push(event.name);
        emitStatus(statusTarget, {
          phase: 'tool',
          name: event.name,
          args: event.args,
          index: event.index,
          partial: false,
        });
      } else if (event.type === 'progress') {
        // Connection-retry notices become a status line rather than a chat message.
        emitStatus(statusTarget, { phase: 'reconnecting', message: event.message });
      } else if (event.type === 'interim') {
        // Mid-process prose (text the model wrote before a tool call) is a real
        // message to the user — deliver it as its own chat message. The turn is
        // not done, so no 'done' status and no markCompleted here. Emitted only
        // after streamCompletion fully drained, so awaiting the write does not
        // stall the token stream.
        if (event.text) {
          turnReplyParts.push(event.text);
          await dispatchResultText(event.text, routing);
        }
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes.
        //
        // Completion is recorded before the answer is written, and that order
        // matters: a message that is answered while still `processing` gets
        // replayed by the sweep on the next container kill and answered twice.
        sawResult = true;
        emitStatus(statusTarget, { phase: 'done', ...(turnReasoningEffort ? { effort: turnReasoningEffort } : {}) });
        // Land the terminal status before the answer. Status events no longer
        // share a seq space with chat rows, so without this the bubble's
        // collapse/delete could race the answer it belongs to. Cheap here: the
        // token stream has already drained by the time `result` is emitted.
        await flushStatus();
        await markCompleted(initialBatchIds);
        await getSessionClient().acknowledgeMemoryEdits(memoryEditIds);
        memoryEditIds = [];
        if (taskRunId) {
          await clearTaskContinuation(providerName, taskRunId);
          query.end();
        }
        if (event.text) {
          assistantReply = event.text;
          turnReplyParts.push(event.text);
          await dispatchResultText(event.text, routing);
        }
        // Summarize any episode this turn closed, once the conversation goes quiet.
        pendingTurnIds = [];
        scheduleEpisodeSummaryDrain({ provider });
        // Reset per-turn tracking for the next turn in this (still-open) query.
        mainAgentTouchedMemory = false;
        turnToolCalls = [];
        turnReplyParts = [];
        turnReasoningEffort = undefined;
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
    signal?.removeEventListener('abort', endOnAbort);
    if (!sawResult) {
      emitStatus(statusTarget, { phase: 'done', ...(turnReasoningEffort ? { effort: turnReasoningEffort } : {}) });
    }
    // Drain any coalesced status writes so the host observes the terminal
    // 'done' before the next turn begins.
    await flushStatus();
  }

  return { continuation: queryContinuation, assistantReply };
}

/**
 * Owner-only topic divider, written as a plain outbound row so it lands before
 * the reply (outbound writes deliver eagerly in-request).
 *
 * Suppressed whenever it carries no information — otherwise a busy day turns
 * into a wall of labels. A resume always announces, since knowing *which*
 * thread was picked up is the whole value.
 */
async function writeTopicDivider(
  event: Extract<ProviderEvent, { type: 'topic' }>,
  routing: RoutingContext,
): Promise<void> {
  if (!routing.senderIsPrivileged) return;
  if (event.action === 'new' && (event.first || event.closedTrivial)) return;

  const suffix =
    event.action === 'resumed'
      ? ` · resumed${event.lastActiveAt ? ` (last discussed ${relativeWhen(event.lastActiveAt)})` : ''}`
      : '';
  try {
    await writeMessageOut({
      id: generateId(),
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      // `silent: true` — the divider is a label on the reply that follows, not
      // its own event, so it should not ping on its own.
      content: JSON.stringify({ text: `${event.emoji} ${event.title}${suffix}`, plain: true, silent: true }),
    });
  } catch (err) {
    log(`Topic divider failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  if (event.type === 'activity') return;
  const detail =
    'text' in event
      ? event.text?.slice(0, 200) || '(empty)'
      : 'name' in event
        ? event.name
        : 'message' in event
          ? event.message
          : 'continuation' in event
            ? event.continuation
            : 'phase' in event
              ? event.phase
              : 'effort' in event
                ? event.effort
                : 'title' in event
                  ? `${event.emoji} ${event.title}`
                  : '';
  log(`${event.type}: ${detail}`);
}

/** Fixed destination for a turn's ephemeral status rows. */
interface StatusTarget {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  in_reply_to: string | null;
}

/**
 * Resolve where a turn's status rows should be written. Fixed for the turn,
 * so processQuery resolves it once and reuses it for every phase/tool row.
 */
export async function resolveStatusTarget(routing: RoutingContext): Promise<StatusTarget | null> {
  const dest = await resolveReplyDestination(routing);
  if (!dest) return null;
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';

  // The reply destination for a scheduled task is usually the same chat as
  // the latest human message, but the turn anchor is the task row itself. A
  // fresh destination lookup used to replace that anchor with the latest
  // human message id, making a 23-second task display "Done in 2392s" when the
  // person had last spoken 40 minutes earlier. Preserve the current batch for
  // same-destination status; only cross-destination status needs a lookup.
  if (channelType === routing.channelType && platformId === routing.platformId) {
    return {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: routing.threadId,
      in_reply_to: routing.inReplyTo,
    };
  }

  const destRouting = await resolveDestinationThread(channelType, platformId);
  return {
    channel_type: channelType,
    platform_id: platformId,
    thread_id: destRouting?.threadId ?? null,
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
  };
}

// --- Non-blocking status writer ------------------------------------------
//
// Status/phase rows are ephemeral UI hints that drive the host-side live
// "thinking" card. They MUST NOT be awaited inside the provider event loop:
// the provider is an async-generator chain, so awaiting an HTTP write there
// suspends `streamCompletion`'s `for await (chunk of stream)` and stops
// draining the model's SSE socket — throttling token intake and making the
// turn feel frozen. Instead we coalesce to the latest pending status and
// flush it on a background single-flight loop; the token stream is never
// gated on the network. Coalescing (latest-wins) also bounds host work to
// roughly one write per flush regardless of how fast the model streams.
let pendingStatus: { target: StatusTarget; payload: Record<string, unknown> } | null = null;
let statusFlush: Promise<void> | null = null;

function emitStatus(target: StatusTarget | null, payload: Record<string, unknown>): void {
  if (!target) return;
  pendingStatus = { target, payload };
  if (!statusFlush) statusFlush = drainStatus();
}

async function drainStatus(): Promise<void> {
  try {
    while (pendingStatus) {
      const { target, payload } = pendingStatus;
      pendingStatus = null;
      await writeStatusMessage({ ...target, payload });
    }
  } catch (err) {
    log(`status flush error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    statusFlush = null;
  }
}

/** Await any in-flight/pending status writes (turn end, so 'done' lands last). */
async function flushStatus(): Promise<void> {
  while (statusFlush) await statusFlush;
}

/**
 * Emit one status event and wait for it to land. Used off the token-stream hot
 * path (command replies, error notices) where there is no resolved turn target
 * to reuse; the streaming event loop uses the non-blocking `emitStatus` above.
 */
async function emitStatusNow(routing: RoutingContext, payload: Record<string, unknown>): Promise<void> {
  const target = await resolveStatusTarget(routing);
  if (!target) return;
  emitStatus(target, payload);
  await flushStatus();
}

/**
 * Parse the agent's final text and dispatch to destinations.
 *
 * - `<message to="name">…</message>` blocks route explicitly (multiple blocks
 *   = multiple deliveries). Trailing text outside blocks is scratchpad only.
 * - Bare text (no blocks) is delivered to resolveReplyDestination — the
 *   inbound sender, or the sole destination when there is only one.
 * - `<internal>…</internal>` is stripped before delivery and never sent.
 *
 * Exported for tests: this is the last gate between an answer and the user, and
 * both ways it can fail — delivering a blank bubble, or delivering nothing at
 * all — are invisible from the outside.
 */
export async function dispatchResultText(text: string, routing: RoutingContext): Promise<{ sent: number }> {
  const visibleText = stripInternalTags(text);
  const packets = [...visibleText.matchAll(/<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g)];
  const outside: string[] = [];
  let cursor = 0;
  let delivered = 0;
  for (const packet of packets) {
    outside.push(visibleText.slice(cursor, packet.index));
    cursor = packet.index! + packet[0].length;
    const body = packet[2].trim();
    if (!body) continue;
    const destination = await findByName(packet[1]);
    if (destination) {
      await sendToDestination(destination, body, routing);
      delivered++;
    } else outside.push(`[dropped: unknown destination "${packet[1]}"] ${body}`);
  }
  outside.push(visibleText.slice(cursor));
  const visible = stripInternalTags(outside.join('')).trim();
  if (delivered) return { sent: delivered };
  const destination = await resolveReplyDestination(routing);
  if (!destination) {
    log('No destination for the final reply');
    return { sent: 0 };
  }
  const reply = visible || (text.trim() ? EMPTY_ANSWER_FALLBACK : '');
  if (!reply) return { sent: 0 };
  await sendToDestination(destination, reply, routing);
  return { sent: 1 };
}

async function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): Promise<void> {
  // Belt and braces for the one symptom users actually report: a reply that
  // arrives as a blank bubble. Callers filter empties already; this makes it
  // impossible for a future one to forget.
  if (!body.trim()) {
    log(`Refusing to send an empty message to ${dest.name}`);
    return;
  }
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = await resolveDestinationThread(channelType, platformId);
  await writeMessageOut({
    id: generateId(),
    in_reply_to: getCurrentTaskRun()?.runId ?? destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
async function resolveDestinationThread(
  channelType: string,
  platformId: string,
): Promise<{ threadId: string | null; inReplyTo: string | null } | null> {
  try {
    return await getSessionClient().resolveDestinationThread(channelType, platformId);
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
