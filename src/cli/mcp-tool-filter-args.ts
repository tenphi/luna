export function parseMcpToolNameList(raw: string, flag: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${flag} must be a JSON array or comma-separated list of tool name strings`, {
        cause: err,
      });
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error(`${flag} must be a JSON array of tool name strings`);
    }
    return parsed as string[];
  }

  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
