/** Parse CLI boolean flags where bare `--flag` means true and `--flag false` means false. */
export function parseBoolFlag(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (raw === true) return true;
  if (raw === false) return false;
  const s = String(raw).toLowerCase();
  if (s === 'false' || s === '0' || s === 'no') return false;
  return true;
}
