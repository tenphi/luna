import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'node:fs';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  _registerContainerForTesting,
  getActiveContainerCount,
  logAgentStderrLine,
  resolveProviderName,
  stopAllContainers,
} from './container-runner.js';
import * as runtime from './container-runtime.js';
import { log } from './log.js';

vi.mock('./container-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runtime.js')>('./container-runtime.js');
  return { ...actual, stopContainer: vi.fn() };
});

/** Minimal stand-in for the `container run` child process we track per session. */
function fakeContainerProcess(): ChildProcess & { close: () => void } {
  const proc = new EventEmitter() as ChildProcess & { close: () => void };
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    close: () => {
      Object.assign(proc, { exitCode: 0 });
      proc.emit('close', 0);
    },
  });
  return proc;
}

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('mock', 'openai')).toBe('mock');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'openai')).toBe('openai');
  });

  it('defaults to openai when nothing is set', () => {
    expect(resolveProviderName(null, undefined, undefined)).toBe('openai');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('MOCK', null)).toBe('mock');
    expect(resolveProviderName(null, 'OpenAI')).toBe('openai');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'openai', undefined)).toBe('openai');
    expect(resolveProviderName(null, '', undefined)).toBe('openai');
  });

  it('uses the install-wide default before falling back to openai', () => {
    expect(resolveProviderName(null, undefined, 'openai')).toBe('openai');
    expect(resolveProviderName(null, undefined, undefined)).toBe('openai');
  });

  it('explicit provider still wins over the install-wide default', () => {
    expect(resolveProviderName('mock', null, 'openai')).toBe('mock');
    expect(resolveProviderName(null, 'openai', 'mock')).toBe('openai');
  });
});

describe('stopAllContainers', () => {
  const cleanups: Array<() => void> = [];

  function register(sessionId: string): ChildProcess & { close: () => void } {
    const proc = fakeContainerProcess();
    cleanups.push(_registerContainerForTesting(sessionId, { process: proc, containerName: `luna-agent-${sessionId}` }));
    return proc;
  }

  beforeEach(() => {
    vi.mocked(runtime.stopContainer).mockReset();
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('stops every running container, not just the first', async () => {
    const a = register('sess-a');
    const b = register('sess-b');
    vi.mocked(runtime.stopContainer).mockImplementation((name: string) => {
      (name.endsWith('sess-a') ? a : b).close();
    });

    await stopAllContainers('host-shutdown', 1000);

    expect(vi.mocked(runtime.stopContainer).mock.calls.map(([name]) => name)).toEqual([
      'luna-agent-sess-a',
      'luna-agent-sess-b',
    ]);
  });

  it('gives up at the deadline instead of holding shutdown open', async () => {
    register('sess-stuck');
    // A container that ignores the stop — shutdown must not wait on it.
    vi.mocked(runtime.stopContainer).mockImplementation(() => {});

    const started = Date.now();
    await stopAllContainers('host-shutdown', 50);

    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not try to stop a process that already exited', async () => {
    const proc = register('sess-gone');
    proc.close();

    await stopAllContainers('host-shutdown', 1000);

    expect(runtime.stopContainer).not.toHaveBeenCalled();
  });

  it('is a no-op with nothing running', async () => {
    expect(getActiveContainerCount()).toBe(0);
    await stopAllContainers('host-shutdown', 60_000);
    expect(runtime.stopContainer).not.toHaveBeenCalled();
  });
});

describe('logAgentStderrLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function levelOf(line: string): 'error' | 'debug' | null {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    logAgentStderrLine(line, 'sess-a');
    const level = error.mock.calls.length ? 'error' : debug.mock.calls.length ? 'debug' : null;
    vi.restoreAllMocks();
    return level;
  }

  it('logs the failures behind a failed turn or a broken agent as errors', () => {
    for (const line of [
      '[openai-provider] error: 503 Our servers are currently overloaded. Please try again later.',
      '[agent-runner] Startup failed TypeError: undefined is not an object',
      '[mcp-tools] Server startup failed',
      '[openai-mcp-bridge] Failed to connect MCP server "luna": spawn bun ENOENT',
    ]) {
      expect(levelOf(line)).toBe('error');
    }
  });

  it('keeps retried model errors and routine output at debug level', () => {
    for (const line of [
      '[openai-provider] retrying after error: 429 Rate limit reached',
      '[poll-loop] Poll iteration failed, retrying: socket hang up',
      '[openai-provider] Adaptive effort=medium (180ms)',
      '[openai-mcp-bridge] Connected MCP server "luna"',
    ]) {
      expect(levelOf(line)).toBe('debug');
    }
  });

  it('passes the line and session through unchanged', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    logAgentStderrLine('[openai-provider] error: 500 Internal error', 'sess-b');
    expect(error).toHaveBeenCalledWith('[openai-provider] error: 500 Internal error', { session: 'sess-b' });
  });

  /**
   * The prefixes are the agent runner's own messages. The runner cannot be
   * imported here (Bun-only modules), so its sources are read as text: a
   * reworded message would otherwise drop back to debug level silently.
   */
  it('matches messages the agent runner still prints', () => {
    const read = (file: string): string =>
      fs.readFileSync(new URL(`../container/agent-runner/src/${file}`, import.meta.url), 'utf8');
    expect(read('index.ts')).toContain("'[agent-runner] Startup failed'");
    expect(read('mcp-tools/index.ts')).toContain("'[mcp-tools] Server startup failed'");
    const bridge = read('providers/openai/tools/mcp-bridge.ts');
    expect(bridge).toContain('`[openai-mcp-bridge] ${msg}`');
    expect(bridge).toContain('log(`Failed to connect MCP server ');
  });
});
