/**
 * Models often emit literal `\n` / `\t` / `\r` (two characters) inside tool-call
 * strings instead of real newlines/tabs. Normalize those so exact-string edits
 * match on-disk content and don't write `\n` into the file body.
 */
export function normalizeEditArg(s: string): string {
  if (!s.includes('\\')) return s;
  return s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}
