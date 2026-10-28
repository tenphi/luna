import { describe, expect, it } from 'vitest';

import { hasOwnDateBound, windowedQuery } from './search.js';

const base = { mailbox: 'ada', limit: 20 };

describe('hasOwnDateBound', () => {
  it('is false for a query with no time constraint', () => {
    expect(hasOwnDateBound(base)).toBe(false);
    expect(hasOwnDateBound({ ...base, from: 'robin@example.test' })).toBe(false);
  });

  it('is true when since or until is given', () => {
    expect(hasOwnDateBound({ ...base, since: '2026-02-03' })).toBe(true);
    expect(hasOwnDateBound({ ...base, until: '2026-02-03' })).toBe(true);
  });

  it('is true when the passthrough carries a date operator', () => {
    for (const query of ['newer_than:2d', 'older_than:1y', 'after:2026/01/01', 'before:2026/02/01']) {
      expect(hasOwnDateBound({ ...base, query })).toBe(true);
    }
  });
});

describe('windowedQuery', () => {
  it('adds the window and keeps the spam and trash exclusions', () => {
    const built = windowedQuery(base, 7);

    expect(built).toContain('newer_than:7d');
    expect(built).toContain('-in:spam -in:trash -in:drafts');
  });

  it('keeps other filters intact', () => {
    const built = windowedQuery({ ...base, from: 'robin@example.test' }, 90);

    expect(built).toContain('from:robin@example.test');
    expect(built).toContain('newer_than:90d');
  });
});
