import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: Object.fromEntries(['debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, vi.fn()])),
}));

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  containerReachableUrl,
  readonlyMountArgs,
  stopContainer,
  STOP_CONTAINER_TIMEOUT_MS,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  refreshContainerHostGateway,
} from './container-runtime.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('containerReachableUrl', () => {
  it.each(['http://127.0.0.1:8080/v1', 'http://localhost:8080/v1', 'http://host.docker.internal:8080/v1'])(
    'rewrites %s to the bridge gateway',
    (url) => {
      expect(containerReachableUrl(url)).toBe(`http://${CONTAINER_HOST_GATEWAY}:8080/v1`);
    },
  );

  it('keeps the caller-supplied path shape', () => {
    expect(containerReachableUrl('http://127.0.0.1:8080')).toBe(`http://${CONTAINER_HOST_GATEWAY}:8080`);
    expect(containerReachableUrl('http://127.0.0.1:8080/')).toBe(`http://${CONTAINER_HOST_GATEWAY}:8080/`);
  });

  it.each(['https://api.openai.com/v1', 'http://10.0.0.5:8080/v1', 'not a url', '', undefined])(
    'leaves %s alone',
    (url) => {
      expect(containerReachableUrl(url)).toBe(url);
    },
  );

  it('refreshes a boot-time fallback after the container network appears', () => {
    mockExecSync.mockReturnValueOnce(JSON.stringify([{ status: { ipv4Gateway: '192.168.65.1' } }]));

    expect(refreshContainerHostGateway()).toBe('192.168.65.1');
    expect(CONTAINER_HOST_GATEWAY).toBe('192.168.65.1');
    expect(containerReachableUrl('http://host.docker.internal:18800')).toBe('http://192.168.65.1:18800');
  });
});

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--mount', 'type=bind,source=/host/path,target=/container/path,readonly']);
  });
});

describe('stopContainer', () => {
  it('calls container stop for valid container names', () => {
    stopContainer('luna-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop luna-test-123`, {
      stdio: 'pipe',
      timeout: STOP_CONTAINER_TIMEOUT_MS,
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('auto-starts when system status fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} system start`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    expect(log.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('cleanupOrphans', () => {
  it('stops running agent containers but leaves OneCLI infra and non-luna containers alone', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'luna-agent-111' } },
      { status: 'stopped', configuration: { id: 'luna-agent-222' } },
      { status: 'running', configuration: { id: 'luna-agent-333' } },
      // OneCLI gateway/postgres are managed separately and must NOT be swept.
      { status: 'running', configuration: { id: 'luna-onecli-gateway-abc' } },
      { status: 'running', configuration: { id: 'luna-onecli-postgres-abc' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop luna-agent-111`, {
      stdio: 'pipe',
      timeout: STOP_CONTAINER_TIMEOUT_MS,
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop luna-agent-333`, {
      stdio: 'pipe',
      timeout: STOP_CONTAINER_TIMEOUT_MS,
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['luna-agent-111', 'luna-agent-333'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans();

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to list running Luna containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });
});
