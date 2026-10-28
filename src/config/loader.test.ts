import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/luna-config-loader-test';
const CONFIG_DIR = path.join(TEST_ROOT, 'config');
const DEFAULT_PATH = path.join(CONFIG_DIR, 'default.jsonc');
const LOCAL_PATH = path.join(CONFIG_DIR, 'local.jsonc');
let env: Record<string, string> = {};

vi.mock('./paths.js', () => ({
  configDir: () => path.join('/tmp/luna-config-loader-test', 'config'),
  defaultConfigPath: () => path.join('/tmp/luna-config-loader-test', 'config', 'default.jsonc'),
  localConfigPath: () => path.join('/tmp/luna-config-loader-test', 'config', 'local.jsonc'),
}));

vi.mock('../install-paths.js', () => ({
  getAgentDir: () => path.join('/tmp/luna-config-loader-test', 'agent'),
  getExternalMcpsImportPath: () => path.join('/tmp/luna-config-loader-test', 'external-mcps.json'),
}));

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      if (env[k]) out[k] = env[k];
    }
    return out;
  },
  removeEnvKeys: (keys: string[]) => {
    for (const key of keys) delete env[key];
  },
}));

import {
  clearConfigCache,
  configLayerErrors,
  loadLunaConfig,
  resolveInstallDefaults,
  resolveModelRole,
  resolveOpenAiProviderConfig,
  resolveRunnerProvider,
} from './loader.js';
import { mergeLunaConfig } from './merge.js';
import { parseJsonc, stripJsonComments } from './jsonc.js';
import { writeLocalConfig } from './write.js';

beforeEach(() => {
  env = {};
  clearConfigCache();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
});

afterEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('jsonc', () => {
  it('strips line and block comments', () => {
    const raw = `{
      // line comment
      "a": 1,
      /* block */
      "b": "two"
    }`;
    expect(parseJsonc(stripJsonComments(raw))).toEqual({ a: 1, b: 'two' });
  });
});

describe('unparseable layers', () => {
  it('reports a layer that exists but does not parse, instead of silently using defaults', () => {
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ install: { assistantName: 'Luna' } }));
    // A stray key with no value — the shape a hand-edit or a bad merge leaves behind.
    fs.writeFileSync(LOCAL_PATH, '{ "install": { "assistantName": "Andy" }, "users": }');
    clearConfigCache();

    const errors = configLayerErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(LOCAL_PATH);
    expect(errors[0].message).toBeTruthy();

    // Still falls back so the host can boot and be fixed — but no longer silently.
    expect(loadLunaConfig().install?.assistantName).toBe('Luna');
  });

  it('reports nothing when a layer is merely absent', () => {
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ install: { assistantName: 'Luna' } }));
    clearConfigCache();

    expect(configLayerErrors()).toEqual([]);
    expect(loadLunaConfig().install?.assistantName).toBe('Luna');
  });

  it('clears stale errors when the file is fixed', () => {
    fs.writeFileSync(DEFAULT_PATH, '{}');
    fs.writeFileSync(LOCAL_PATH, '{ broken');
    clearConfigCache();
    expect(configLayerErrors()).toHaveLength(1);

    fs.writeFileSync(LOCAL_PATH, '{ "install": { "timezone": "Europe/Berlin" } }');
    clearConfigCache();
    expect(configLayerErrors()).toEqual([]);
    expect(loadLunaConfig().install?.timezone).toBe('Europe/Berlin');
  });
});

describe('mergeLunaConfig', () => {
  it('deep-merges mcpServers by name', () => {
    const merged = mergeLunaConfig([
      { agent: { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } } },
      { agent: { mcpServers: { b: { toolsAllow: ['t'] } } } },
    ]);
    expect(merged.agent?.mcpServers?.a?.command).toBe('x');
    expect(merged.agent?.mcpServers?.b?.command).toBe('y');
    expect(merged.agent?.mcpServers?.b?.toolsAllow).toEqual(['t']);
  });

  it('local overlay wins for scalars', () => {
    const merged = mergeLunaConfig([{ install: { assistantName: 'Andy' } }, { install: { assistantName: 'Luna' } }]);
    expect(merged.install?.assistantName).toBe('Luna');
  });

  it('merges named providers, and a later layer wins per key', () => {
    const merged = mergeLunaConfig([
      {
        providers: { openai: { baseUrl: 'https://main/v1' } },
        models: { main: { provider: 'openai', id: 'chat' } },
      },
      {
        providers: { lmstudio: { baseUrl: 'http://lm/v1' } },
        models: { main: { provider: 'lmstudio' } },
      },
    ]);
    expect(merged.providers?.openai?.baseUrl).toBe('https://main/v1');
    expect(merged.providers?.lmstudio?.baseUrl).toBe('http://lm/v1');
    // The id survives a layer that only changed the provider.
    expect(merged.models?.main).toEqual({ provider: 'lmstudio', id: 'chat' });
  });
});

describe('loadLunaConfig', () => {
  it('loads default and local layers', () => {
    fs.writeFileSync(
      DEFAULT_PATH,
      JSON.stringify({ install: { assistantName: 'Default' }, models: { main: { provider: 'openai' } } }),
    );
    fs.writeFileSync(LOCAL_PATH, JSON.stringify({ install: { assistantName: 'Local' } }));

    const cfg = loadLunaConfig();
    expect(cfg.install?.assistantName).toBe('Local');
    expect(cfg.models?.main?.provider).toBe('openai');
  });

  it('does not read agent/container.json at runtime', () => {
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ models: { main: { provider: 'openai' } } }));
    fs.mkdirSync(path.join(TEST_ROOT, 'agent'), { recursive: true });
    fs.writeFileSync(
      path.join(TEST_ROOT, 'agent', 'container.json'),
      JSON.stringify({ model: 'import-only-model', provider: 'openai' }),
    );

    const cfg = loadLunaConfig();
    expect(cfg.models?.main?.id).toBeUndefined();
  });
});

describe('resolveInstallDefaults', () => {
  it('uses models.main and ignores legacy environment defaults', () => {
    process.env.LUNA_DEFAULT_PROVIDER = 'ignored-provider';
    process.env.LUNA_DEFAULT_MODEL = 'ignored-model';
    env = { LUNA_DEFAULT_PROVIDER: 'ignored-dotenv-provider', LUNA_DEFAULT_MODEL: 'ignored-dotenv-model' };
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ models: { main: { provider: 'openai', id: 'from-config' } } }));
    clearConfigCache();
    expect(resolveInstallDefaults()).toEqual({ provider: 'openai', model: 'from-config' });
    delete process.env.LUNA_DEFAULT_PROVIDER;
    delete process.env.LUNA_DEFAULT_MODEL;
  });
});

describe('resolveModelRole', () => {
  it('resolves the role against its named provider', () => {
    fs.writeFileSync(
      DEFAULT_PATH,
      JSON.stringify({
        providers: {
          openai: { baseUrl: 'https://main/v1' },
          lmstudio: { baseUrl: 'http://lm/v1' },
        },
        models: { main: { provider: 'lmstudio', id: 'chat' } },
      }),
    );
    clearConfigCache();
    const main = resolveModelRole('main');
    expect(main.provider.name).toBe('lmstudio');
    expect(main.provider.baseUrl).toBe('http://lm/v1');
    expect(main.id).toBe('chat');
  });

  it('falls back to the openai provider when the role names none', () => {
    fs.writeFileSync(
      DEFAULT_PATH,
      JSON.stringify({
        providers: { openai: { baseUrl: 'https://main/v1' } },
        models: { main: { id: 'chat' } },
      }),
    );
    clearConfigCache();
    expect(resolveModelRole('main').provider.name).toBe('openai');
  });
});

describe('resolveOpenAiProviderConfig', () => {
  const prevBaseUrl = process.env.OPENAI_BASE_URL;
  const prevApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = prevBaseUrl;
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
    clearConfigCache();
  });

  it('uses models.main + providers for endpoint and model, but resolves API keys from env', () => {
    process.env.OPENAI_BASE_URL = 'https://ignored.example/v1';
    process.env.OPENAI_MODEL = 'ignored-model';
    process.env.OPENAI_API_KEY = 'secret-key';
    env = {
      OPENAI_BASE_URL: 'https://ignored-dotenv.example/v1',
      OPENAI_MODEL: 'ignored-dotenv-model',
    };
    fs.writeFileSync(
      DEFAULT_PATH,
      JSON.stringify({
        providers: { openai: { baseUrl: 'https://configured.example/v1' } },
        models: { main: { provider: 'openai', id: 'configured-model' } },
      }),
    );
    clearConfigCache();
    expect(resolveOpenAiProviderConfig()).toEqual({
      baseUrl: 'https://configured.example/v1',
      model: 'configured-model',
      apiKey: 'secret-key',
    });
    delete process.env.OPENAI_MODEL;
  });
});

describe('resolveRunnerProvider', () => {
  function writeProviders(providers: Record<string, unknown>): void {
    fs.writeFileSync(LOCAL_PATH, JSON.stringify({ providers }));
    clearConfigCache();
  }

  it('maps an openai-compatible entry to the openai runner whatever it is named', () => {
    writeProviders({ blackboxai: { baseUrl: 'https://api.blackbox.ai/v1' } });
    expect(resolveRunnerProvider('blackboxai')).toBe('openai');
  });

  it('honours an explicit openai-compatible kind', () => {
    writeProviders({ lmstudio: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' } });
    expect(resolveRunnerProvider('lmstudio')).toBe('openai');
  });

  it('is idempotent for an entry already named openai', () => {
    writeProviders({ openai: { baseUrl: 'http://127.0.0.1:8080/v1' } });
    expect(resolveRunnerProvider('openai')).toBe('openai');
    expect(resolveRunnerProvider(resolveRunnerProvider('openai'))).toBe('openai');
  });

  it('passes through names with no providers entry so mock still resolves', () => {
    writeProviders({ blackboxai: { baseUrl: 'https://api.blackbox.ai/v1' } });
    expect(resolveRunnerProvider('mock')).toBe('mock');
    expect(resolveRunnerProvider('MOCK')).toBe('mock');
  });

  it('defaults to openai when unset', () => {
    writeProviders({});
    expect(resolveRunnerProvider(undefined)).toBe('openai');
    expect(resolveRunnerProvider('  ')).toBe('openai');
  });

  it('does not silently turn a reranker entry into a chat runner', () => {
    writeProviders({ 'llama-reranker': { kind: 'llama-server-reranker', baseUrl: 'http://127.0.0.1:8080/v1' } });
    expect(resolveRunnerProvider('llama-reranker')).not.toBe('openai');
  });
});

describe('writeLocalConfig', () => {
  it('patches models.main in local overlay', () => {
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ models: { main: { provider: 'openai', id: null } } }));
    writeLocalConfig({ models: { main: { id: 'new-model' } } });
    clearConfigCache();
    const cfg = loadLunaConfig();
    expect(cfg.models?.main?.provider).toBe('openai');
    expect(cfg.models?.main?.id).toBe('new-model');
  });

  it('round-trips a roster to disk', () => {
    // Without a `users` branch in writeLocalConfig this is a silent no-op: the call succeeds, the
    // file is rewritten without the section, and setup appears to have configured nobody.
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ users: {}, owner: null }));
    writeLocalConfig({
      users: { ada: { name: 'Ada Marlow', telegramHandle: 'ada_marlow' } },
      owner: 'ada',
    });

    const onDisk = parseJsonc<Record<string, unknown>>(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    expect(onDisk.owner).toBe('ada');
    expect(onDisk.users).toEqual({ ada: { name: 'Ada Marlow', telegramHandle: 'ada_marlow' } });

    clearConfigCache();
    expect(loadLunaConfig().users?.ada?.telegramHandle).toBe('ada_marlow');
  });

  it('adds a person without dropping the ones already there', () => {
    fs.writeFileSync(DEFAULT_PATH, '{}');
    writeLocalConfig({ users: { ada: { telegramHandle: 'ada_marlow' } }, owner: 'ada' });
    writeLocalConfig({ users: { bo: { telegramHandle: 'bo_luna' } } });

    clearConfigCache();
    const cfg = loadLunaConfig();
    expect(Object.keys(cfg.users ?? {}).sort()).toEqual(['ada', 'bo']);
    expect(cfg.owner).toBe('ada');
  });

  it('removes a person on an explicit null', () => {
    fs.writeFileSync(DEFAULT_PATH, '{}');
    writeLocalConfig({ users: { ada: {}, bob: {} }, owner: 'ada' });
    writeLocalConfig({ users: { bob: null } } as unknown as Parameters<typeof writeLocalConfig>[0]);

    clearConfigCache();
    expect(Object.keys(loadLunaConfig().users ?? {})).toEqual(['ada']);
  });

  it('does not strip the roster as if it were a product default', () => {
    // sanitizeLocalDocument spreads unknown sections through untouched and has no rule for `users`.
    // That is the intended behavior — there are no defaults to strip — so pin it, because adding a
    // rule later would quietly start deleting entries that equal some default.
    fs.writeFileSync(DEFAULT_PATH, JSON.stringify({ users: {}, owner: null }));
    writeLocalConfig({ users: { ada: { enabled: true } }, owner: 'ada' });

    const onDisk = parseJsonc<Record<string, unknown>>(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    expect(onDisk.users).toEqual({ ada: { enabled: true } });
  });
});
