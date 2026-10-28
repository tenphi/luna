import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseJsonc, readJsoncFile, stripJsonComments, stripTrailingCommas } from './jsonc.js';

/**
 * The parser has to read what the formatter writes.
 *
 * It did not, and the consequence was invisible: Prettier formats `config/*.jsonc` with trailing
 * commas, `JSON.parse` rejects them, `readJsoncFile` swallows the error and returns null — so one
 * `npm run format` made every committed default vanish, and nothing failed. The tests write their
 * own config files, so none of them read the one that was broken.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-jsonc-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseJsonc', () => {
  it('reads what Prettier writes: comments and trailing commas', () => {
    const written = `{
  // a line comment
  "install": {
    "assistantName": "Luna",
    "container": { "maxConcurrent": 5, },
  },
  /* a block comment */
  "models": {
    "main": { "provider": "openai", "id": "gpt-4o-mini" },
  },
}
`;
    expect(parseJsonc(written)).toEqual({
      install: { assistantName: 'Luna', container: { maxConcurrent: 5 } },
      models: { main: { provider: 'openai', id: 'gpt-4o-mini' } },
    });
  });

  it('leaves commas that are data alone', () => {
    // A comma inside a string is content, and so is one that only looks trailing because a `}`
    // follows it inside quotes.
    expect(parseJsonc('{ "note": "one, two,", "next": "a }", }')).toEqual({
      note: 'one, two,',
      next: 'a }',
    });
  });

  it('keeps a `//` inside a string', () => {
    expect(parseJsonc('{ "baseUrl": "https://api.openai.com/v1" }')).toEqual({
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('handles trailing commas in arrays and nested ones', () => {
    expect(parseJsonc('{ "ignore": [".git", "node_modules", ], "nested": [[1, 2, ], ], }')).toEqual({
      ignore: ['.git', 'node_modules'],
      nested: [[1, 2]],
    });
  });

  it('still throws on genuinely broken JSON', () => {
    // The fix must not turn a real syntax error into a silent partial read.
    expect(() => parseJsonc('{ "a": }')).toThrow();
  });

  it('reads a formatted file off disk', () => {
    const file = path.join(dir, 'default.jsonc');
    fs.writeFileSync(file, '{\n  // comment\n  "mcpPort": 18800,\n}\n');
    expect(readJsoncFile(file)).toEqual({ mcpPort: 18800 });
  });

  it('returns null for a file that is not there, rather than throwing', () => {
    expect(readJsoncFile(path.join(dir, 'missing.jsonc'))).toBeNull();
  });
});

describe('the two stripping passes', () => {
  it('strips comments without touching structure', () => {
    expect(stripJsonComments('{"a":1} // tail').trim()).toBe('{"a":1}');
  });

  it('preserves whitespace when dropping a comma, so error line numbers still line up', () => {
    const input = '{\n  "a": 1,\n}';
    const stripped = stripTrailingCommas(input);
    expect(stripped.split('\n').length).toBe(input.split('\n').length);
    expect(JSON.parse(stripped)).toEqual({ a: 1 });
  });
});

describe('the real config files', () => {
  it('parses config/default.jsonc as committed', () => {
    // The regression test that matters: this is the file the formatter rewrites and the loader
    // depends on. If it stops parsing, every default silently disappears.
    const parsed = readJsoncFile<Record<string, unknown>>(path.join(process.cwd(), 'config', 'default.jsonc'));
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveProperty('models');
    expect(parsed).toHaveProperty('memory');
  });
});
