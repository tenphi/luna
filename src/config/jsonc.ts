import fs from 'fs';

/**
 * Minimal JSONC parser: strips comments and trailing commas, then `JSON.parse`.
 *
 * Trailing commas are handled because **the project's own formatter writes them.** Prettier
 * formats `config/*.jsonc` as JSONC, where `{ "a": 1, }` is legal, and this parser used to reject
 * it — so `npm run format` silently made `config/default.jsonc` unparseable, `readJsoncFile`
 * returned null for it, and every committed default vanished. Nothing failed loudly: the tests
 * write their own config files, so they never read the one that was broken.
 *
 * A parser that cannot read what the formatter produces is the bug, not the formatter.
 */

export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    const next = input[i + 1];

    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = input[i];
        out += c;
        if (c === '\\' && i + 1 < len) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && input[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len - 1 && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Removes `,` before a closing `}` or `]`, outside of strings. */
export function stripTrailingCommas(input: string): string {
  let out = '';
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i]!;

    if (ch === '"') {
      // Copied verbatim: a comma inside a string is data.
      out += ch;
      i++;
      while (i < len) {
        const c = input[i]!;
        out += c;
        if (c === '\\' && i + 1 < len) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < len && /\s/.test(input[j]!)) j++;
      if (j < len && (input[j] === '}' || input[j] === ']')) {
        // Drop the comma, keep the whitespace so line numbers in a parse error still line up.
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

export function parseJsonc<T = unknown>(content: string): T {
  return JSON.parse(stripTrailingCommas(stripJsonComments(content))) as T;
}

export function readJsoncFile<T = unknown>(filePath: string): T | null {
  try {
    return parseJsonc<T>(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}
