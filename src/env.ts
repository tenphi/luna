import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type EnvEntry = { key: string; value: string };

function entry(line: string): EnvEntry | null {
  const match = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
  if (!match) return null;
  const [, key, raw] = match;
  const quote = raw[0];
  const value = raw.length > 1 && (quote === '"' || quote === "'") && raw.at(-1) === quote ? raw.slice(1, -1) : raw;
  return { key: key.trim(), value };
}

function contents(directory = process.cwd()): string {
  try {
    return fs.readFileSync(path.resolve(directory, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function save(lines: string[]): void {
  const destination = path.resolve('.env');
  const temporary = path.join(path.dirname(destination), `.luna-env-${randomUUID()}`);
  try {
    const text = lines.join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(temporary, text === '\n' ? '' : text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Read only requested assignments; credentials never enter process.env. */
export function readEnvFile(keys: string[], directory = process.cwd()): Record<string, string> {
  const selected: Record<string, string> = {};
  const wanted = new Set(keys);
  contents(directory)
    .split(/\r?\n/)
    .forEach((line) => {
      const parsed = entry(line);
      if (parsed && wanted.has(parsed.key) && parsed.value !== '') selected[parsed.key] = parsed.value;
    });
  return selected;
}

/** Preserve unrelated lines and replace duplicate assignments with one value. */
export function writeEnvFile(updates: Record<string, string>): void {
  const remaining = new Map(Object.entries(updates));
  for (const [key, value] of remaining) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
      throw new Error('Environment assignments require a valid key and a single-line value');
    }
  }
  const lines = contents()
    .split(/\r?\n/)
    .flatMap((line) => {
      const parsed = entry(line);
      if (!parsed || !Object.hasOwn(updates, parsed.key)) return [line];
      if (!remaining.has(parsed.key)) return [];
      const replacement = `${parsed.key}=${remaining.get(parsed.key)}`;
      remaining.delete(parsed.key);
      return [replacement];
    });
  while (lines.at(-1) === '') lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  save(lines);
}

export function removeEnvKeys(keys: string[]): void {
  if (!keys.length || !fs.existsSync(path.resolve('.env'))) return;
  const unwanted = new Set(keys);
  save(
    contents()
      .split(/\r?\n/)
      .filter((line) => {
        const parsed = entry(line);
        return !parsed || !unwanted.has(parsed.key);
      }),
  );
}
