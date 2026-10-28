import { describe, expect, it } from 'vitest';

import { HOST_BOOT_MARKER_PREFIX, linesSinceLastHostBoot } from './host-boot.js';

describe('linesSinceLastHostBoot', () => {
  it('returns lines after the latest boot marker', () => {
    const lines = [
      `${HOST_BOOT_MARKER_PREFIX}2026-07-23T10:00:00.000Z`,
      '[apple] messages: [denied] old',
      `${HOST_BOOT_MARKER_PREFIX}2026-07-23T12:00:00.000Z`,
      '[apple] messages: Messages access OK',
      '[host-mcp] listening on http://0.0.0.0:18800',
    ];
    expect(linesSinceLastHostBoot(lines)).toEqual([
      '[apple] messages: Messages access OK',
      '[host-mcp] listening on http://0.0.0.0:18800',
    ]);
  });

  it('falls back to a legacy tail when no marker exists', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    expect(linesSinceLastHostBoot(lines, 5)).toEqual(['line-45', 'line-46', 'line-47', 'line-48', 'line-49']);
  });

  it('returns empty when the marker is the last line', () => {
    expect(linesSinceLastHostBoot([`${HOST_BOOT_MARKER_PREFIX}2026-07-23T12:00:00.000Z`])).toEqual([]);
  });
});
