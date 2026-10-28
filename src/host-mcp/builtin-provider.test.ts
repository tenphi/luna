import { describe, expect, it, vi } from 'vitest';

vi.mock('./builtins/index.js', () => ({
  BUILTIN_PROVIDERS: [
    {
      id: 'test',
      isEnabled: () => true,
      listServers: () => [{ name: 'test_server' }],
      prepare: async () => ({
        factories: { test_server: () => ({ connect: async () => {} }) as never },
        disabledServerNames: new Set(['disabled_server']),
      }),
    },
    {
      id: 'off',
      isEnabled: () => false,
      listServers: () => [{ name: 'skipped' }],
      prepare: async () => ({ factories: { skipped: () => ({}) as never } }),
    },
  ],
}));

import { prepareBuiltinProviders } from './builtin-provider.js';

describe('prepareBuiltinProviders', () => {
  it('merges factories from enabled providers only', async () => {
    const runtime = await prepareBuiltinProviders();
    expect(Object.keys(runtime.factories)).toEqual(['test_server']);
    expect(Object.keys(runtime.bridges)).toEqual([]);
    expect(runtime.disabledServerNames.has('disabled_server')).toBe(true);
    expect(runtime.disabledServerNames.has('skipped')).toBe(false);
  });
});
