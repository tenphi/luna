import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/luna-setup-persist-test';
const CONFIG_DIR = path.join(TEST_ROOT, 'config');
const LOCAL_PATH = path.join(CONFIG_DIR, 'local.jsonc');
const ENV_PATH = path.join(TEST_ROOT, '.env');

vi.mock('./paths.js', () => ({
  configDir: () => path.join('/tmp/luna-setup-persist-test', 'config'),
  defaultConfigPath: () => path.join('/tmp/luna-setup-persist-test', 'config', 'default.jsonc'),
  localConfigPath: () => path.join('/tmp/luna-setup-persist-test', 'config', 'local.jsonc'),
}));

vi.mock('../install-paths.js', () => ({
  getAgentDir: () => path.join('/tmp/luna-setup-persist-test', 'agent'),
  getExternalMcpsImportPath: () => path.join('/tmp/luna-setup-persist-test', 'external-mcps.json'),
  getMountAllowlistPath: () => path.join('/tmp/luna-setup-persist-test', 'mount-allowlist.json'),
}));

import { clearConfigCache } from './loader.js';
import { persistOnecliUrl, persistOpenAiEndpoint, stripSetupLocalEnvKeys } from './setup-persist.js';

beforeEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  process.chdir(TEST_ROOT);
  fs.writeFileSync(path.join(CONFIG_DIR, 'default.jsonc'), '{}\n');
  fs.writeFileSync(
    ENV_PATH,
    [
      'OPENAI_API_KEY=secret-key',
      'OPENAI_BASE_URL=https://old.example/v1',
      'OPENAI_MODEL=old-model',
      'ONECLI_URL=http://127.0.0.1:10254',
      'TZ=UTC',
    ].join('\n') + '\n',
  );
});

afterEach(() => {
  clearConfigCache();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('setup-persist', () => {
  it('persists OpenAI endpoint to local.jsonc and strips non-secrets from .env', () => {
    persistOpenAiEndpoint({
      baseUrl: 'https://api.deepinfra.com/v1',
      apiKey: 'new-secret',
      model: 'Qwen/test',
      provider: 'openai',
    });

    const local = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    expect(local.providers.openai.baseUrl).toBe('https://api.deepinfra.com/v1');
    expect(local.models.main.id).toBe('Qwen/test');
    // default provider (openai) may still be written; apiKey stays as env ref from defaults merge path

    const env = fs.readFileSync(ENV_PATH, 'utf-8');
    expect(env).toContain('OPENAI_API_KEY=new-secret');
    expect(env).not.toMatch(/^OPENAI_BASE_URL=/m);
    expect(env).not.toMatch(/^OPENAI_MODEL=/m);
    expect(env).not.toMatch(/^LUNA_DEFAULT_/m);
  });

  it('persists OneCLI URL to local.jsonc', () => {
    persistOnecliUrl('http://127.0.0.1:10254');
    const local = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
    expect(local.install.onecli.url).toBe('http://127.0.0.1:10254');
    expect(fs.readFileSync(ENV_PATH, 'utf-8')).not.toMatch(/^ONECLI_URL=/m);
  });

  it('stripSetupLocalEnvKeys removes migrated keys but keeps secrets', () => {
    fs.writeFileSync(
      LOCAL_PATH,
      JSON.stringify({
        providers: { openai: { baseUrl: 'https://api.deepinfra.com/v1' } },
        models: { main: { id: 'Qwen/test' } },
      }) + '\n',
    );
    stripSetupLocalEnvKeys();
    const env = fs.readFileSync(ENV_PATH, 'utf-8');
    expect(env).toContain('OPENAI_API_KEY=secret-key');
    expect(env).not.toMatch(/^OPENAI_BASE_URL=/m);
    expect(env).not.toMatch(/^ONECLI_URL=/m);
    expect(env).not.toMatch(/^TZ=/m);
  });
});
