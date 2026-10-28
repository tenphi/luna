import { describe, it, expect } from 'vitest';

import { formatTransportError } from './transport-errors.js';

describe('formatTransportError', () => {
  it('suggests luna service commands on ENOENT', () => {
    const out = formatTransportError(new Error('connect ENOENT /tmp/luna.sock'));
    expect(out).toContain('luna service start');
    expect(out).toContain('luna service restart');
  });

  it('suggests luna service commands on ECONNREFUSED', () => {
    const out = formatTransportError(new Error('connect ECONNREFUSED'));
    expect(out).toContain('luna service start');
  });

  it('falls back to a generic transport error for other failures', () => {
    const out = formatTransportError(new Error('some unrelated failure'));
    expect(out).toBe('luna: transport error: some unrelated failure\n');
    expect(out).not.toContain('launchctl');
    expect(out).not.toContain('systemctl');
  });
});
