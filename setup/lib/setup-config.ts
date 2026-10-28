type SettingBase = {
  key: string;
  label: string;
  help: string;
  surface: 'flag' | 'flag+ui';
  envVar?: string;
  flag?: string;
  group?: string;
  secret?: boolean;
};
export type EntrySurface = SettingBase['surface'];
export type Entry = SettingBase &
  (
    | {
        type: 'string' | 'url';
        default?: string;
        placeholder?: string;
        validate?: (value: string) => string | undefined;
      }
    | { type: 'enum'; options: { value: string; label: string; hint?: string }[]; default?: string }
    | { type: 'boolean'; default?: boolean }
    | { type: 'integer'; default?: number; min?: number; max?: number }
  );
const endpoint = (value: string): string | undefined => {
  try {
    if (['https:', 'http:'].includes(new URL(value).protocol)) return;
  } catch {
    /* Report invalid input below. */
  }
  return 'Enter an HTTP or HTTPS URL';
};
export const CONFIG: Entry[] = [
  {
    key: 'openaiBaseUrl',
    group: 'OpenAI',
    label: 'Model endpoint',
    type: 'url',
    surface: 'flag+ui',
    placeholder: 'https://api.openai.com/v1',
    validate: endpoint,
    help: 'Base URL of the OpenAI-compatible model service.',
  },
  {
    key: 'openaiModel',
    group: 'OpenAI',
    label: 'Main model',
    type: 'string',
    surface: 'flag+ui',
    placeholder: 'gpt-6-luna',
    help: 'Main agent model; the default is gpt-6-luna.',
  },
  {
    key: 'openaiApiKey',
    group: 'OpenAI',
    label: 'Model API key',
    type: 'string',
    secret: true,
    surface: 'flag+ui',
    help: 'Endpoint credential; keyless local endpoints may leave this empty.',
  },
  {
    key: 'onecliApiHost',
    group: 'OneCLI',
    label: 'Remote OneCLI URL',
    type: 'url',
    surface: 'flag+ui',
    default: 'https://api.onecli.sh',
    placeholder: 'https://api.onecli.sh',
    validate: endpoint,
    help: 'Connect an existing OneCLI gateway instead of installing it locally.',
  },
  {
    key: 'onecliApiToken',
    group: 'OneCLI',
    label: 'OneCLI token',
    type: 'string',
    secret: true,
    surface: 'flag+ui',
    placeholder: 'oc_…',
    validate: (value) => (value.startsWith('oc_') ? undefined : 'Expected an oc_ token'),
    help: 'Access token for the remote OneCLI gateway.',
  },
  {
    key: 'displayName',
    label: 'Your name',
    type: 'string',
    surface: 'flag',
    envVar: 'LUNA_DISPLAY_NAME',
    help: 'Name used during onboarding; skips the name prompt.',
  },
  {
    key: 'skip',
    label: 'Skip setup steps',
    type: 'string',
    surface: 'flag',
    envVar: 'LUNA_SKIP',
    help: 'Comma-separated setup steps to omit when diagnosing an installation.',
  },
];
const words = (entry: Entry): string[] =>
  entry.key
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .split(' ');
export const envVarFor = (entry: Entry): string => entry.envVar ?? `LUNA_${words(entry).join('_').toUpperCase()}`;
export const flagFor = (entry: Entry): string => entry.flag ?? `--${words(entry).join('-')}`;
export const findByFlag = (flag: string): Entry | null => CONFIG.find((entry) => flagFor(entry) === flag) ?? null;
