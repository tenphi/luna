/**
 * Format a tool invocation as a single-line trace for CLI stderr (max 80 cols).
 */
const PREFIX = '→ ';

function compactValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const inner = value.map(compactValue).filter(Boolean).join(',');
    return inner.length > 24 ? `${inner.slice(0, 21)}…` : inner;
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > 24 ? `${s.slice(0, 21)}…` : s;
  }
  return String(value);
}

function compactArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const v = compactValue(value);
    if (v === '') continue;
    parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

export function formatToolLine(name: string, args: Record<string, unknown>, maxLen = 80): string {
  const params = compactArgs(args);
  let line = params.length > 0 ? `${PREFIX}${name} ${params}` : `${PREFIX}${name}`;
  line = line.replace(/\s+/g, ' ').trim();
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 1)}…`;
}
