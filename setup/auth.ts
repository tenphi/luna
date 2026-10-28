import { resolveOpenAiProviderConfig } from '../src/config/loader.js';
import { persistOpenAiEndpoint } from '../src/config/setup-persist.js';
import { requireOption } from './lib/arguments.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  if (args.includes('--create')) {
    const value = requireOption(args, '--value');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Enter an HTTP(S) endpoint without credentials in the URL');
    persistOpenAiEndpoint({ provider: 'openai', baseUrl: value });
  }
  const baseUrl = resolveOpenAiProviderConfig().baseUrl?.trim();
  // This establishes configuration; the separate agent ping verifies a model round trip.
  emitStatus('AUTH', {
    STATUS: baseUrl ? 'success' : 'missing',
    OPENAI_OK: Boolean(baseUrl),
    CREATED: args.includes('--create'),
    ...(baseUrl ? { BASE_URL: baseUrl } : {}),
  });
  if (!baseUrl) process.exitCode = 1;
}
