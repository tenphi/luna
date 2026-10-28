import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearConfigCache } from '../../src/config/loader.js';
import {
  isLocalOnecliUrl,
  parseFlags,
  readFromDotenv,
  readFromEnv,
  readFromUnifiedConfig,
} from './setup-config-parse.js';

/**
 * The argv shapes that actually arrive, which are not the ones you would write by hand.
 * `pnpm run setup:auto -- <flags>` is one way in, and pnpm prepends a
 * literal `--` to whatever follows: verified against pnpm 10, `run script --` yields
 * `['--']` and `run script -- --help` yields `['--', '--help']`.
 *
 * That separator used to be read as POSIX end-of-options, so every flag behind it went
 * into a `rest` array nothing read. `--help` behind it opened the interactive wizard
 * and `--onecli-api-host` configured nothing, while both worked when setup:auto was
 * invoked directly — which is how it went unnoticed while the help text documented
 * those flags.
 */
describe('parseFlags', () => {
  it('parses flags behind the `--` that pnpm prepends', () => {
    expect(parseFlags(['--', '--help']).help).toBe(true);
    expect(parseFlags(['--', '--onecli-api-host', 'https://vault.example.com']).values).toEqual({
      onecliApiHost: 'https://vault.example.com',
    });
  });

  it('parses the same flags when setup:auto is invoked directly, with no separator', () => {
    expect(parseFlags(['--help']).help).toBe(true);
    expect(parseFlags(['--onecli-api-host=https://vault.example.com']).values).toEqual({
      onecliApiHost: 'https://vault.example.com',
    });
  });

  it('treats a lone `--` as nothing to do, which is the no-flags case', () => {
    expect(parseFlags(['--'])).toEqual({ values: {}, help: false, errors: [] });
  });

  it('refuses a bare word instead of silently dropping it', () => {
    // `luna setup redeploy` is refused by the setup runner, which names the CLI instead;
    // this is the backstop for a word it cannot classify, and for direct invocation.
    const result = parseFlags(['--', 'redeploy']);
    expect(result.errors).toEqual([
      'Unexpected argument: redeploy — setup takes flags, not commands (see `luna --help`)',
    ]);
    expect(result.values).toEqual({});
  });

  it('still refuses an unknown flag', () => {
    expect(parseFlags(['--', '--bogus']).errors).toEqual(['Unknown flag: --bogus']);
  });
});

describe('isLocalOnecliUrl', () => {
  it('treats loopback hosts as local', () => {
    expect(isLocalOnecliUrl('http://127.0.0.1:10254')).toBe(true);
    expect(isLocalOnecliUrl('http://localhost:10254')).toBe(true);
  });

  it('treats remote hosts as non-local', () => {
    expect(isLocalOnecliUrl('https://api.onecli.sh')).toBe(false);
  });
});

describe('readFromDotenv', () => {
  let prevCwd: string;
  let tempDir: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-setup-config-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps OPENAI_* and LUNA_DEFAULT_MODEL from .env', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      ['OPENAI_BASE_URL=https://api.example.com/v1', 'OPENAI_API_KEY=secret', 'LUNA_DEFAULT_MODEL=my-model'].join('\n'),
    );
    expect(readFromDotenv()).toEqual({
      openaiBaseUrl: 'https://api.example.com/v1',
      openaiApiKey: 'secret',
      openaiModel: 'my-model',
    });
  });

  it('does not map local ONECLI_URL to onecliApiHost', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\nONECLI_API_KEY=oc_test\n');
    expect(readFromDotenv()).toEqual({ onecliApiToken: 'oc_test' });
  });

  it('maps remote ONECLI_URL to onecliApiHost', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'ONECLI_URL=https://vault.example.com\n');
    expect(readFromDotenv()).toEqual({ onecliApiHost: 'https://vault.example.com' });
  });
});

describe('readFromUnifiedConfig', () => {
  let prevCwd: string;
  let tempDir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    prevCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-setup-unified-'));
    process.chdir(tempDir);
    for (const key of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'LUNA_DEFAULT_MODEL']) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    clearConfigCache();
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'default.jsonc'), '{}\n');
    fs.writeFileSync(path.join(tempDir, '.env'), '# empty\n');
  });

  afterEach(() => {
    for (const key of Object.keys(envSnapshot)) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    process.chdir(prevCwd);
    clearConfigCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps providers and models.main from local.jsonc', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config', 'local.jsonc'),
      JSON.stringify({
        providers: { openai: { baseUrl: 'https://api.deepinfra.com/v1' } },
        models: {
          main: { provider: 'openai', id: 'Qwen/Qwen3.6-35B-A3B' },
        },
      }),
    );
    clearConfigCache();
    expect(readFromUnifiedConfig()).toEqual({
      openaiBaseUrl: 'https://api.deepinfra.com/v1',
      openaiModel: 'Qwen/Qwen3.6-35B-A3B',
    });
  });

  it('does not map local install.onecli.url to onecliApiHost', () => {
    fs.writeFileSync(
      path.join(tempDir, 'config', 'local.jsonc'),
      JSON.stringify({ install: { onecli: { url: 'http://127.0.0.1:10254' } } }),
    );
    clearConfigCache();
    expect(readFromUnifiedConfig()).toEqual({});
  });
});

describe('readFromEnv', () => {
  it('reads LUNA_* setup overrides', () => {
    const env = {
      LUNA_OPENAI_BASE_URL: 'http://localhost:8080/v1',
      LUNA_OPENAI_MODEL: 'gpt-4o-mini',
    } as NodeJS.ProcessEnv;
    expect(readFromEnv(env)).toEqual({
      openaiBaseUrl: 'http://localhost:8080/v1',
      openaiModel: 'gpt-4o-mini',
    });
  });
});
