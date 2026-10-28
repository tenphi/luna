import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

vi.mock('./osascript.js', () => ({ runOsascript: vi.fn() }));

import { runOsascript } from './osascript.js';
import { probeApp } from './permissions.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('Automation permission probes', () => {
  it.each(['notes', 'contacts'] as const)('can check %s without a populated library', async (app) => {
    vi.mocked(runOsascript).mockImplementation(async (script) => {
      if (/first folder|first person/.test(script)) throw new Error('No library object is available');
      return app;
    });

    expect((await probeApp(app)).status).toBe('ok');
  });

  it.each(['notes', 'contacts'] as const)('still reports denied Automation access for %s', async (app) => {
    vi.mocked(runOsascript).mockRejectedValue(new Error('Not authorized to send Apple events (-1743)'));

    expect((await probeApp(app)).status).toBe('denied');
  });
});

describe('Messages protected-file access', () => {
  it('checks the store can actually be opened before probing Automation', async () => {
    vi.spyOn(fs, 'openSync').mockReturnValue(42);
    vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
    vi.mocked(runOsascript).mockResolvedValue('Messages');
    expect((await probeApp('messages')).status).toBe('ok');
  });

  it('reports Full Disk Access denial without trying Automation', async () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    });
    const result = await probeApp('messages');
    expect(result.status).toBe('denied');
    expect(result.message).toContain('Full Disk Access');
    expect(runOsascript).not.toHaveBeenCalled();
  });

  it('does not treat a missing Messages store as a grant that should be watched', async () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
    });
    const result = await probeApp('messages');
    expect(result.status).toBe('missing_cli');
    expect(result.message).not.toContain('Full Disk Access');
  });
});
