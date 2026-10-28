import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readEnvFile, removeEnvKeys, writeEnvFile } from './env.js';
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-env-contract-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true });
});
const file = () => path.join(directory, '.env');

it('reads selected quoted assignments without changing the environment', () => {
  fs.writeFileSync(file(), '# example\nLUNA_TEST_FIRST="alpha=beta"\r\nSECOND=hidden\nEMPTY=\n');
  expect(readEnvFile(['LUNA_TEST_FIRST', 'EMPTY'])).toEqual({ LUNA_TEST_FIRST: 'alpha=beta' });
  expect(process.env.LUNA_TEST_FIRST).toBeUndefined();
});
it('updates duplicates, preserves comments, and restricts file permissions', () => {
  fs.writeFileSync(file(), '# keep\nFIRST=old\nFIRST=stale\nSECOND=keep\n');
  writeEnvFile({ FIRST: 'new', THIRD: 'added' });
  expect(readEnvFile(['FIRST', 'SECOND', 'THIRD'])).toEqual({ FIRST: 'new', SECOND: 'keep', THIRD: 'added' });
  expect(fs.readFileSync(file(), 'utf8').match(/^FIRST=/gm)).toHaveLength(1);
  expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  removeEnvKeys(['SECOND']);
  expect(fs.readFileSync(file(), 'utf8')).toContain('# keep');
  expect(readEnvFile(['SECOND'])).toEqual({});
  expect(fs.readdirSync(directory)).toEqual(['.env']);
});
it('rejects assignment injection before modifying a file', () => {
  expect(() => writeEnvFile({ GOOD: 'one\nOTHER=two' })).toThrow();
  expect(() => writeEnvFile({ 'BAD=KEY': 'one' })).toThrow();
  expect(fs.existsSync(file())).toBe(false);
  expect(readEnvFile(['MISSING'])).toEqual({});
});
