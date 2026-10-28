import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { readEnvFile } from '../src/env.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

function running(): boolean {
  return spawnSync('container', ['system', 'status'], { stdio: 'pipe' }).status === 0;
}
async function startRuntime(): Promise<void> {
  if (!commandExists('container')) throw new Error('Install Apple Container first');
  if (running()) return;
  const start = spawnSync('container', ['system', 'start'], { stdio: 'inherit', timeout: 30_000 });
  if (start.status !== 0) throw new Error('Apple Container could not start');
  const deadline = Date.now() + 30_000;
  do {
    if (running()) return;
    await delay(2000);
  } while (Date.now() < deadline);
  throw new Error('Apple Container did not become ready');
}
export async function run(_args: string[]): Promise<void> {
  const image = getDefaultContainerImage();
  let built = false;
  let tested = false;
  try {
    await startRuntime();
    const cjk =
      (process.env.INSTALL_CJK_FONTS ?? readEnvFile(['INSTALL_CJK_FONTS']).INSTALL_CJK_FONTS)?.toLowerCase() === 'true';
    const build = spawnSync(
      'container',
      ['build', ...(cjk ? ['--build-arg', 'INSTALL_CJK_FONTS=true'] : []), '-t', image, '.'],
      { cwd: path.join(process.cwd(), 'container'), stdio: 'inherit' },
    );
    built = build.status === 0;
    if (built) {
      const test = spawnSync('container', ['run', '--rm', '--entrypoint', '/bin/echo', image, 'Luna container ready'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      tested = test.status === 0 && test.stdout.includes('Luna container ready');
    }
    emitStatus('SETUP_CONTAINER', {
      IMAGE: image,
      RUNTIME: 'container',
      BUILD_OK: built,
      TEST_OK: tested,
      STATUS: built && tested ? 'success' : 'failed',
    });
  } catch (error) {
    emitStatus('SETUP_CONTAINER', {
      IMAGE: image,
      RUNTIME: 'container',
      BUILD_OK: built,
      TEST_OK: tested,
      STATUS: 'failed',
      ERROR: error instanceof Error ? error.message : 'Container setup failed',
    });
  }
  if (!built || !tested) process.exitCode = 1;
}
