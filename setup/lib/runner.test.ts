import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spawnQuiet, StatusStream } from './runner.js';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
it('parses a completed status packet across arbitrary chunks and an unterminated final line', () => {
  const accepted: string[] = [];
  const parser = new StatusStream((block) => accepted.push(block.type));
  const input =
    'Build output\n=== LUNA SETUP: FIXTURE ===\r\nDETAIL: http://example.test:42\nSTATUS: success\n=== END ===';
  for (const character of input) parser.write(character);
  parser.finish();
  expect(accepted).toEqual(['FIXTURE']);
  expect(parser.blocks[0].fields).toEqual({ DETAIL: 'http://example.test:42', STATUS: 'success' });
  expect(parser.transcript).toBe(input);
});
it('reports a missing child executable and finishes a private log with redacted arguments', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-runner-contract-'));
  directories.push(directory);
  const file = path.join(directory, 'child.log');
  const result = await spawnQuiet(path.join(directory, 'missing-executable'), ['--api-key=synthetic-value'], file);
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  const log = fs.readFileSync(file, 'utf8');
  expect(log).toContain('--api-key=[redacted]');
  expect(log).not.toContain('synthetic-value');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
