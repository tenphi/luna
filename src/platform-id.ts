/** The protected terminal socket establishes this local operator identity. */
export const CLI_LOCAL_USER_ID = 'cli:local';

export function namespacedPlatformId(channel: string, raw: string): string {
  if (channel === 'cli') return raw.replace(/^cli:/, '');
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}
