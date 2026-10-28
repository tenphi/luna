import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])('builds with the system Bash and optional fonts=%s', (fonts) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-build-fixture-'));
  temporary.push(directory);
  const project = path.join(directory, 'project with spaces');
  fs.mkdirSync(path.join(project, 'container'), { recursive: true });
  fs.mkdirSync(path.join(project, 'setup/lib'), { recursive: true });
  for (const name of ['container/build.sh', 'setup/lib/install-slug.sh']) {
    fs.copyFileSync(path.join(process.cwd(), name), path.join(project, name));
  }
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const argumentsFile = path.join(directory, 'arguments');
  fs.writeFileSync(path.join(bin, 'container'), '#!/bin/bash\nprintf "%s\\0" "$@" > "$LUNA_TEST_ARGUMENTS"\n', {
    mode: 0o700,
  });
  const built = spawnSync('/bin/bash', [path.join(project, 'container/build.sh'), 'fixture-tag'], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_CJK_FONTS: String(fonts),
      LUNA_TEST_ARGUMENTS: argumentsFile,
    },
    encoding: 'utf8',
  });
  expect(built.stderr).toBe('');
  expect(built.status).toBe(0);
  const args = fs.readFileSync(argumentsFile, 'utf8').split('\0').filter(Boolean);
  expect(args).toEqual([
    'build',
    ...(fonts ? ['--build-arg', 'INSTALL_CJK_FONTS=true'] : []),
    '--tag',
    expect.stringMatching(/^luna-agent-[a-f0-9]{8}:fixture-tag$/),
    path.join(project, 'container'),
  ]);
});
