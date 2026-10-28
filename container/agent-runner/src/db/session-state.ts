/**
 * Persistent key/value state for the container, stored server-side in the
 * host's session.db (session_state table) and reached over the SessionClient.
 *
 * Primary use: remember each provider's opaque continuation id so the agent's
 * conversation resumes across container restarts. Keyed per provider because
 * continuations are provider-private.
 */
import { getSessionClient } from '../session/client.js';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): Promise<string | undefined> {
  return getSessionClient().getSessionState(key);
}

function setValue(key: string, value: string): Promise<void> {
  return getSessionClient().setSessionState(key, value);
}

function deleteValue(key: string): Promise<void> {
  return getSessionClient().deleteSessionState(key);
}

export function getContinuation(providerName: string): Promise<string | undefined> {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): Promise<void> {
  return setValue(continuationKey(providerName), id);
}

function taskContinuationKey(providerName: string, runId: string): string {
  return `task_continuation:${providerName.toLowerCase()}:${runId}`;
}

export function getTaskContinuation(providerName: string, runId: string): Promise<string | undefined> {
  return getValue(taskContinuationKey(providerName, runId));
}

export function setTaskContinuation(providerName: string, runId: string, id: string): Promise<void> {
  return setValue(taskContinuationKey(providerName, runId), id);
}

export function clearTaskContinuation(providerName: string, runId: string): Promise<void> {
  return deleteValue(taskContinuationKey(providerName, runId));
}

export async function clearContinuation(providerName: string): Promise<void> {
  await deleteValue(continuationKey(providerName));
  await clearContextSummary(providerName);
}

function contextSummaryKey(providerName: string): string {
  return `context_summary:${providerName.toLowerCase()}`;
}

/** Archived conversation summary injected when a session is rotated after compaction. */
export function getContextSummary(providerName: string): Promise<string | undefined> {
  return getValue(contextSummaryKey(providerName));
}

export function setContextSummary(providerName: string, summary: string): Promise<void> {
  return setValue(contextSummaryKey(providerName), summary);
}

export function clearContextSummary(providerName: string): Promise<void> {
  return deleteValue(contextSummaryKey(providerName));
}

// Token usage used to live here as a single `usage:<provider>` key. It had no
// time dimension, was scoped to one session, and `/clear` wiped it — so it
// could not answer "today" or "this month". It now lives in the host's
// `usage_daily` ledger, reached via SessionClient.recordUsage.
