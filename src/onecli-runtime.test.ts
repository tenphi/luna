import { describe, expect, it } from 'vitest';

import { DEFAULT_ONECLI_URL, isLocalOnecliUrl } from './onecli-runtime.js';

describe('isLocalOnecliUrl', () => {
  it('detects loopback URLs', () => {
    expect(isLocalOnecliUrl('http://127.0.0.1:10254')).toBe(true);
    expect(isLocalOnecliUrl('http://localhost:10254')).toBe(true);
    expect(isLocalOnecliUrl('http://[::1]:10254')).toBe(true);
  });

  it('rejects remote URLs', () => {
    expect(isLocalOnecliUrl('https://api.onecli.sh')).toBe(false);
    expect(isLocalOnecliUrl('not-a-url')).toBe(false);
  });
});

describe('DEFAULT_ONECLI_URL', () => {
  it('uses loopback app port', () => {
    expect(DEFAULT_ONECLI_URL).toBe('http://127.0.0.1:10254');
  });
});
