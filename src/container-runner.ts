import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DATA_DIR } from './config.js';
import {
  loadContainerConfig,
  readStoredContainerConfig,
  updateStoredContainerConfig,
  writeSessionContainerConfig,
} from './container-config.js';
import { renderAgentGroupDockerfile } from './container-image-build.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { resolveInstallDefaults, resolveRunnerProvider } from './config/loader.js';
import { getAgentGroup } from './db/agent-groups.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import './providers/index.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';
import { markContainerRunning, markContainerStopped, sessionDir } from './session-manager.js';
import { clearLiveness } from './session-liveness.js';
import type { Session } from './types.js';
import { prepareSessionForSpawn } from './container/spawn/prep.js';
import { prepareMounts } from './container/spawn/assets.js';
import { containerArguments, sessionApiEndpoint } from './container/spawn/arguments.js';

type Running = { process: ChildProcess; containerName: string };
const activeContainers = new Map<string, Running>();
const starting = new Map<string, Promise<boolean>>();
export const getActiveContainerCount = (): number => activeContainers.size;
export const isContainerRunning = (session: string): boolean => activeContainers.has(session);

/**
 * Agent stderr lines that mean a turn or the agent itself failed. They come
 * from the agent runner: `logProviderError` (format-error.ts), the runner and
 * MCP tool server entry points, and the MCP bridge. A retried model error is
 * logged as `retrying after error:` and stays at debug level.
 */
const AGENT_FAILURE_PREFIXES = [
  '[openai-provider] error: ',
  '[agent-runner] Startup failed',
  '[mcp-tools] Server startup failed',
  '[openai-mcp-bridge] Failed to connect MCP server',
];

/**
 * Agent failures go to the error log, where `luna status` and `luna health`
 * read them. Other agent output stays at debug level.
 */
export function logAgentStderrLine(line: string, session: string): void {
  const failed = AGENT_FAILURE_PREFIXES.some((prefix) => line.startsWith(prefix));
  log[failed ? 'error' : 'debug'](line, { session });
}

async function launch(session: Session): Promise<void> {
  const group = getAgentGroup(session.agent_group_id);
  if (!group) throw new Error('Session agent no longer exists');
  await prepareSessionForSpawn(group, session);
  const settings = loadContainerConfig(group.id, session.id);
  writeSessionContainerConfig(group.id, session.id, settings);
  const provider = resolveRunnerProvider(
    resolveProviderName(session.agent_provider, settings.provider, resolveInstallDefaults().provider),
  );
  const contribution =
    getProviderContainerConfig(provider)?.({
      sessionDir: sessionDir(group.id, session.id),
      agentGroupId: group.id,
      hostEnv: process.env,
      sessionApi: sessionApiEndpoint(group.id, session.id),
    }) ?? {};
  const name = `luna-agent-${randomUUID()}`;
  const arguments_ = await containerArguments(
    name,
    group,
    session,
    settings,
    contribution,
    prepareMounts(group, session, settings, contribution),
  );
  clearLiveness(session.id);
  const process_ = spawn(CONTAINER_RUNTIME_BIN, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { process: process_, containerName: name };
  activeContainers.set(session.id, record);
  markContainerRunning(session.id);
  process_.stdout?.resume();
  // readline joins lines that arrive split across stderr chunks, so a failure
  // line is classified whole.
  if (process_.stderr) {
    createInterface({ input: process_.stderr, crlfDelay: Infinity }).on('line', (line) => {
      if (line) logAgentStderrLine(line, session.id);
    });
  }
  const remove = (): void => {
    if (activeContainers.get(session.id) !== record) return;
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
  };
  process_.once('close', remove);
  process_.once('error', (error) => {
    remove();
    log.error('Agent process failed', { session: session.id, error });
  });
  await new Promise<void>((resolve, reject) => {
    process_.once('spawn', resolve);
    process_.once('error', reject);
  });
}

/** One startup per session; failed attempts stay retryable by the host sweep. */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) return Promise.resolve(true);
  if (starting.has(session.id)) return starting.get(session.id)!;
  const pending = launch(session).then(
    () => true,
    (error) => {
      log.warn('Agent startup will be retried', { session: session.id, error });
      return false;
    },
  );
  const result = pending.finally(() => {
    starting.delete(session.id);
  });
  starting.set(session.id, result);
  return result;
}
export function killContainer(id: string, reason: string, afterExit?: () => void): void {
  const running = activeContainers.get(id);
  if (!running) return;
  if (afterExit) running.process.once('close', afterExit);
  log.info('Stopping an agent process', { id, reason });
  try {
    stopContainer(running.containerName);
  } catch {
    running.process.kill('SIGKILL');
  }
}
export function _registerContainerForTesting(id: string, entry: Running): () => void {
  activeContainers.set(id, entry);
  return () => {
    if (activeContainers.get(id) === entry) activeContainers.delete(id);
  };
}

export async function stopAllContainers(reason: string, timeoutMs = 10_000): Promise<void> {
  const entries = [...activeContainers.entries()];
  if (entries.length === 0) return;

  log.info('Stopping agent containers', { count: entries.length, reason });

  const pending = new Set(entries.map(([sessionId]) => sessionId));
  const exits = entries.map(
    ([sessionId, entry]) =>
      new Promise<void>((resolve) => {
        if (entry.process.exitCode !== null || entry.process.signalCode !== null) {
          pending.delete(sessionId);
          resolve();
          return;
        }
        entry.process.once('close', () => {
          pending.delete(sessionId);
          resolve();
        });
        killContainer(sessionId, reason);
      }),
  );

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });

  await Promise.race([Promise.all(exits).then(() => {}), deadline]);
  if (timer) clearTimeout(timer);

  if (pending.size > 0) {
    log.warn('Containers still running past the stop deadline — leaving them to the next boot', {
      remaining: pending.size,
      sessionIds: [...pending],
    });
  }
}

export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
  defaultProvider?: string | null,
): string {
  return (sessionProvider || containerConfigProvider || defaultProvider || 'openai').toLowerCase();
}

export async function buildAgentGroupImage(id: string): Promise<void> {
  const group = getAgentGroup(id);
  if (!group) throw new Error('Agent group not found');
  const settings = readStoredContainerConfig(group);
  if (!settings.packages.apt.length && !settings.packages.npm.length)
    throw new Error('No packages to install. Add packages through luna config agent.');
  const recipe = renderAgentGroupDockerfile(CONTAINER_IMAGE, settings.packages.apt, settings.packages.npm);
  const target = `${CONTAINER_IMAGE_BASE}:${id}`;
  const filename = path.join(DATA_DIR, `Dockerfile.${id}`);
  fs.writeFileSync(filename, recipe);
  try {
    const result = spawnSync(CONTAINER_RUNTIME_BIN, ['build', '-t', target, '-f', filename, '.'], {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Image build failed (exit ${result.status}): ${result.stderr?.toString().trim() ?? ''}`);
  } finally {
    fs.rmSync(filename, { force: true });
  }
  updateStoredContainerConfig(id, { imageTag: target });
}
