#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const repo = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-package-smoke-'));
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG'].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
env.LUNA_HOME = path.join(temporary, 'private-install');
try {
  console.log('Packing the release artifact…');
  execFileSync('npm', ['pack', '--pack-destination', temporary], { stdio: 'pipe', timeout: 60000 });
  console.log('Checking release assets…');
  const tarball = fs.readdirSync(temporary).find((name) => name.endsWith('.tgz'));
  assert(tarball, 'No tarball produced');
  const archive = path.join(temporary, tarball);
  const unpacked = path.join(temporary, 'unpacked');
  fs.mkdirSync(unpacked);
  execFileSync('tar', ['xzf', archive, '-C', unpacked]);
  const shipped = path.join(unpacked, 'package');
  const metadata = JSON.parse(fs.readFileSync(path.join(shipped, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@tenphi/luna');
  assert.equal(metadata.license, 'PolyForm-Noncommercial-1.0.0');
  assert(fs.existsSync(path.join(shipped, 'npm-shrinkwrap.json')), 'The audited npm dependency graph is missing');
  for (const value of Object.values(metadata.dependencies)) assert(!/^(?:link|file|workspace|catalog):/.test(value));
  for (const file of [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'bin/luna',
    'dist/index.js',
    'config/default.jsonc',
    'setup/auto.ts',
    'container/Dockerfile',
    'container/agent-runner/src/index.ts',
    'container/agent-runner/bun.lock',
    'container/fragments/tools.md',
    'container/skills/calendar/SKILL.md',
    'container/agent-runner/src/providers/openai/responses.ts',
    'container/agent-runner/src/providers/openai/effort.ts',
    'src/host-mcp/builtins/apple/native/calendar-helper',
    'src/host-mcp/builtins/email/shared/attach/native/mail-extract',
    'src/voice/native/speech-helper',
  ])
    assert(fs.existsSync(path.join(shipped, file)), `Missing runtime asset: ${file}`);
  const names = execFileSync('tar', ['tzf', archive], { encoding: 'utf8' });
  assert(!/\.(?:test\.(?:ts|js)|map|tsbuildinfo)(?:\n|$)/.test(names), 'Tests or build debris shipped');
  assert(!/package\/(?:data|logs|agent|memory|\.git|node_modules)\//.test(names), 'Private state shipped');
  execFileSync(process.execPath, ['scripts/check-repository-safety.mjs', '--root', shipped], {
    cwd: repo,
    stdio: 'inherit',
  });
  const prefix = path.join(temporary, 'consumer');
  execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', archive], {
    env,
    stdio: 'pipe',
    timeout: 180000,
  });
  const audit = JSON.parse(
    execFileSync('npm', ['audit', '--prefix', prefix, '--omit=dev', '--json'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    }),
  );
  assert.equal(audit.metadata.vulnerabilities.total, 0, 'Installed runtime has known advisories');
  const binary = path.join(prefix, 'node_modules/.bin/luna');
  const run = (args) => execFileSync(binary, args, { cwd: temporary, env, encoding: 'utf8', timeout: 30000 });
  assert.match(run(['--help']), /Usage: luna/);
  assert.match(run(['setup', '--help']), /[Ss]etup/);
  assert.match(run(['config', 'models', 'get', '--json']), /gpt-6-luna/);
  const defaults = fs.readFileSync(path.join(shipped, 'config/default.jsonc'), 'utf8');
  assert.match(defaults, /"effort":\s*"adaptive"/);
  assert.match(defaults, /"api":\s*"responses"/);
  assert.match(run(['config', 'memory', 'get', '--json']), /"enabled":\s*false/);
  // Setup steps run through the materialized install, which has no dev types to compile with.
  assert.match(run(['setup', 'step', 'environment']), /CHECK_ENVIRONMENT/);
  assert(fs.existsSync(path.join(env.LUNA_HOME, 'dist/index.js')), 'The packaged host must ship prebuilt');
  const state = new Database(path.join(env.LUNA_HOME, 'data/luna.db'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(
      state.pragma('user_version', { simple: true }),
      1,
      'Installed state must start at the public baseline',
    );
    const tables = state
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(({ name }) => name);
    assert(tables.includes('reports') && tables.includes('roster_notices'), 'The complete current schema is required');
    assert(!tables.includes('schema_version') && !tables.includes('user_roles'), 'Historical schema state shipped');
  } finally {
    state.close();
  }
  const local = path.join(env.LUNA_HOME, 'config/local.jsonc');
  fs.writeFileSync(local, '{"memory":{"enabled":false,"mission":"invented marker"}}\n');
  const credentials = path.join(env.LUNA_HOME, '.env');
  fs.writeFileSync(credentials, 'OPENAI_API_KEY=fixture\n', { mode: 0o600 });
  const sentinel = path.join(env.LUNA_HOME, 'data/preserved.txt');
  fs.writeFileSync(sentinel, 'invented local data\n');
  const marker = path.join(env.LUNA_HOME, '.luna-package-version');
  // Files an older release shipped and this one removed must not survive the refresh: built-in
  // skills and module instructions are discovered by listing their directories.
  const retired = [
    path.join(env.LUNA_HOME, 'container/skills/retired-fixture/SKILL.md'),
    path.join(env.LUNA_HOME, 'container/agent-runner/src/mcp-tools/retired-fixture.instructions.md'),
    path.join(env.LUNA_HOME, 'src/retired-fixture.ts'),
  ];
  const plantRetired = () => {
    for (const file of retired) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'invented retired asset\n');
    }
  };
  const assertRefreshed = () => {
    for (const file of retired) assert(!fs.existsSync(file), `A retired asset survived the refresh: ${file}`);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), metadata.version);
    assert.equal(fs.readFileSync(local, 'utf8'), '{"memory":{"enabled":false,"mission":"invented marker"}}\n');
    assert.equal(fs.readFileSync(credentials, 'utf8'), 'OPENAI_API_KEY=fixture\n');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'invented local data\n');
  };
  fs.writeFileSync(marker, 'previous-fixture-version');
  plantRetired();
  run(['--help']);
  assertRefreshed();
  // `luna setup` links ~/.local/bin/luna to the install's own launcher, which may come first on
  // PATH. That copy must also pick up a package `npm install -g` replaced.
  fs.writeFileSync(marker, 'previous-fixture-version');
  plantRetired();
  assert.match(
    execFileSync(path.join(env.LUNA_HOME, 'bin/luna'), ['--help'], {
      cwd: temporary,
      env,
      encoding: 'utf8',
      timeout: 30000,
    }),
    /Usage: luna/,
  );
  assertRefreshed();
  console.log(
    'Installed package passed: assets, privacy, CLI, setup help, OpenAI defaults, optional memory, and state-preserving refresh from both launchers.',
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
