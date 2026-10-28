import { describe, expect, it } from 'bun:test';

import { normalizeMemorySlug, normalizeMemoryToolArgs } from './memory-slug.js';

describe('normalizeMemorySlug', () => {
  it('leaves canonical slugs alone', () => {
    expect(normalizeMemorySlug('people/jane-doe')).toBe('people/jane-doe');
    expect(normalizeMemorySlug('budget/review/2031-06')).toBe('budget/review/2031-06');
  });

  it('strips a trailing .md the agent copied from a filename', () => {
    expect(normalizeMemorySlug('budget/review/2031-06.md')).toBe('budget/review/2031-06');
    expect(normalizeMemorySlug('People/Jane.MD')).toBe('People/Jane');
  });

  it('strips repeated .md / .mdx so write-through never creates .md.md', () => {
    expect(normalizeMemorySlug('budget/review/2031-06.md.md')).toBe('budget/review/2031-06');
    expect(normalizeMemorySlug('notes/spec.mdx')).toBe('notes/spec');
  });

  it('trims and strips leading slashes', () => {
    expect(normalizeMemorySlug('  /people/jane.md  ')).toBe('people/jane');
  });
});

describe('normalizeMemoryToolArgs', () => {
  it('normalizes slug and *_slug fields', () => {
    expect(
      normalizeMemoryToolArgs({
        slug: 'people/jane.md',
        from_slug: 'a/b.md',
        to_slug: 'c/d.md.md',
        entity_slug: 'people/bob.md',
        content: 'keep me',
      }),
    ).toEqual({
      slug: 'people/jane',
      from_slug: 'a/b',
      to_slug: 'c/d',
      entity_slug: 'people/bob',
      content: 'keep me',
    });
  });

  it('returns the same object when nothing changes', () => {
    const args = { slug: 'people/jane', content: 'x' };
    expect(normalizeMemoryToolArgs(args)).toBe(args);
  });
});
