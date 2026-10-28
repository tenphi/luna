import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile, writeEnvFile } from '../src/env.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const key = args[args.indexOf('--key') + 1];
  const value = args[args.indexOf('--value') + 1];
  if (!args.includes('--key') || !key || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Provide --key with an uppercase environment name');
  if (!args.includes('--value') || value === undefined) throw new Error('Provide --value with the assignment');
  const existed = Object.hasOwn(readEnvFile([key]), key);
  writeEnvFile({ [key]: value });
  const sync = args.includes('--sync-container');
  if (sync) {
    const destination = path.resolve('data', 'env', 'env');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.resolve('.env'), destination);
    fs.chmodSync(destination, 0o600);
  }
  emitStatus('SET_ENV', { KEY: key, EXISTED: existed, SYNCED_TO_CONTAINER: sync, STATUS: 'success' });
}
