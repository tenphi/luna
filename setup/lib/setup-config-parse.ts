import {
  loadLunaConfig,
  resolveInstallDefaults,
  resolveOpenAiProviderConfig,
  resolveSecretOrValue,
} from '../../src/config/loader.js';
import { readEnvFile } from '../../src/env.js';
import { CONFIG, envVarFor, flagFor, findByFlag, type Entry } from './setup-config.js';
export type ConfigValues = Record<string, string | number | boolean>;
export type FlagParseResult = { values: ConfigValues; help: boolean; errors: string[] };

function decode(entry: Entry, text: string): string | number | boolean | undefined {
  if (entry.type === 'boolean') {
    const normalized = text.trim().toLowerCase();
    if (['1', 'yes', 'true'].includes(normalized)) return true;
    if (['0', 'no', 'false'].includes(normalized)) return false;
    return;
  }
  if (entry.type === 'integer') {
    const number = Number(text);
    if (
      !text.trim() ||
      !Number.isInteger(number) ||
      (entry.min !== undefined && number < entry.min) ||
      (entry.max !== undefined && number > entry.max)
    )
      return;
    return number;
  }
  if (entry.type === 'enum' && !entry.options.some((option) => option.value === text)) return;
  return text;
}
export function isLocalOnecliUrl(address: string): boolean {
  try {
    return new Set(['localhost', '127.0.0.1', '[::1]', '::1']).has(new URL(address).hostname.toLowerCase());
  } catch {
    return false;
  }
}
function configured(values: Record<string, string | undefined>): ConfigValues {
  return Object.fromEntries(Object.entries(values).filter((pair): pair is [string, string] => Boolean(pair[1])));
}
export function readFromDotenv(): ConfigValues {
  const keys = [
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'LUNA_DEFAULT_MODEL',
    'ONECLI_URL',
    'ONECLI_API_KEY',
  ];
  const stored = readEnvFile(keys);
  return configured({
    openaiBaseUrl: stored.OPENAI_BASE_URL,
    openaiApiKey: stored.OPENAI_API_KEY,
    openaiModel: stored.OPENAI_MODEL || stored.LUNA_DEFAULT_MODEL,
    onecliApiToken: stored.ONECLI_API_KEY,
    onecliApiHost: stored.ONECLI_URL && !isLocalOnecliUrl(stored.ONECLI_URL) ? stored.ONECLI_URL : undefined,
  });
}
export function readFromUnifiedConfig(): ConfigValues {
  const config = loadLunaConfig();
  const endpoint = resolveOpenAiProviderConfig();
  const gateway = config.install?.onecli;
  const address = gateway?.url;
  return configured({
    openaiBaseUrl: endpoint.baseUrl,
    openaiApiKey: endpoint.apiKey,
    openaiModel: endpoint.model ?? resolveInstallDefaults().model,
    onecliApiToken: resolveSecretOrValue(gateway?.apiKey),
    onecliApiHost: address && !isLocalOnecliUrl(address) ? address : undefined,
  });
}
export function readFromEnv(environment: NodeJS.ProcessEnv = process.env): ConfigValues {
  const values: ConfigValues = {};
  CONFIG.forEach((entry) => {
    const raw = environment[envVarFor(entry)];
    if (!raw) return;
    const value = decode(entry, raw);
    if (value !== undefined) values[entry.key] = value;
  });
  return values;
}
export function parseFlags(arguments_: string[]): FlagParseResult {
  const result: FlagParseResult = { values: {}, errors: [], help: false };
  const queue = [...arguments_];
  while (queue.length) {
    const token = queue.shift()!;
    if (token === '--') continue;
    if (token === '-h' || token === '--help') {
      result.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      result.errors.push(`Unexpected argument: ${token} — setup takes flags, not commands (see \`luna --help\`)`);
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    const negative = flag.startsWith('--no-');
    const name = negative ? flag.replace('--no-', '--') : flag;
    const entry = findByFlag(name);
    if (!entry) {
      result.errors.push(`Unknown flag: ${token}`);
      continue;
    }
    if (negative && entry.type !== 'boolean') {
      result.errors.push(`${flag} cannot negate this setting`);
      continue;
    }
    const inline = separator < 0 ? undefined : token.slice(separator + 1);
    let raw = inline;
    if (entry.type === 'boolean') raw = negative ? 'false' : (inline ?? 'true');
    else if (raw === undefined && queue[0] && !queue[0].startsWith('--')) raw = queue.shift();
    if (raw === undefined) {
      result.errors.push(`Missing value for ${name}`);
      continue;
    }
    const value = decode(entry, raw);
    const invalid = entry.type === 'string' || entry.type === 'url' ? entry.validate?.(raw) : undefined;
    if (value === undefined || invalid) result.errors.push(`${name}: ${invalid ?? `invalid ${entry.type}`}`);
    else result.values[entry.key] = value;
  }
  return result;
}
export function applyToEnv(values: ConfigValues, environment: NodeJS.ProcessEnv = process.env): void {
  for (const entry of CONFIG) {
    const value = values[entry.key];
    if (value !== undefined) environment[envVarFor(entry)] = String(value);
  }
}
export function printHelp(output: NodeJS.WritableStream = process.stdout): void {
  const descriptions = CONFIG.map((entry) => `  ${flagFor(entry).padEnd(24)} ${entry.help}`);
  output.write(
    [
      'Usage: luna setup [flags...]',
      '',
      ...descriptions,
      '',
      'Flags override LUNA_* environment variables. Run without flags for guided setup.',
      '',
    ].join('\n'),
  );
}
