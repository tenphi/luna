import { localConfigPath } from '../../config/index.js';
import { readEnvFile, writeEnvFile } from '../../env.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

const INSTALL_KEYS = ['OPENAI_API_KEY', 'INSTALL_CJK_FONTS'] as const;

register({
  name: 'env',
  description: 'Show secret and shell-consumed install-wide .env keys.',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, _ctx: CallerContext) => {
    const env = readEnvFile([...INSTALL_KEYS]);
    return {
      env,
      local_config_path: localConfigPath(),
      note: 'Use `luna config set` or `luna config <topic> set` for non-secret install settings.',
    };
  },
});

register({
  name: 'env-set',
  description: 'Set a secret or shell-consumed install-wide .env key (OPENAI_API_KEY or INSTALL_CJK_FONTS).',
  access: 'open',
  parseArgs: (raw) => {
    const key = String(raw.key ?? '');
    const value = String(raw.value ?? '');
    if (!key) throw new Error('--key is required');
    if (!INSTALL_KEYS.includes(key as (typeof INSTALL_KEYS)[number])) {
      throw new Error(`Unknown key: ${key}. Allowed: ${INSTALL_KEYS.join(', ')}`);
    }
    return { key, value };
  },
  handler: async (args, _ctx: CallerContext) => {
    writeEnvFile({ [args.key]: args.value });
    return { set: args.key, value: args.value };
  },
});

register({
  name: 'env-mcp-tools',
  description: 'Deprecated — use `luna config mcp-tools` instead',
  access: 'hidden',
  parseArgs: (raw) => ({
    action: String(raw.action ?? 'get'),
    filters: raw.filters as Record<string, unknown> | undefined,
  }),
  handler: async () => {
    throw new Error('Deprecated — use `luna config mcp-tools` or `luna config mcp-tools set`.');
  },
});
