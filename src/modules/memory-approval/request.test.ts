import { describe, expect, it } from 'vitest';

import { NAME_IT_VALUE, pageFromOptionValue, proposalNeedsOwner, shortenSlug } from './request.js';

describe('pageFromOptionValue', () => {
  it('reads the page off a candidate button', () => {
    expect(pageFromOptionValue('page:ada-marlow/news-preferences')).toBe('ada-marlow/news-preferences');
  });

  it('is null for the buttons that are not a page', () => {
    expect(pageFromOptionValue(NAME_IT_VALUE)).toBeNull();
    expect(pageFromOptionValue('reject')).toBeNull();
    // A plain approve carries no page: memory replays the payload it is already holding.
    expect(pageFromOptionValue('approve')).toBeNull();
  });

  it('is null for a prefix with nothing after it, rather than an empty page', () => {
    expect(pageFromOptionValue('page:')).toBeNull();
    expect(pageFromOptionValue('page:   ')).toBeNull();
  });
});

describe('shortenSlug', () => {
  it('leaves a short slug alone', () => {
    expect(shortenSlug('ada-marlow/news-preferences')).toBe('ada-marlow/news-preferences');
  });

  it('keeps the tail of a deep slug, which is what tells two candidates apart', () => {
    const slug = 'travel/2031/2031-04-02-06-north-harbour-attachments/harbour-lighthouse';
    const short = shortenSlug(slug);
    expect(short.length).toBeLessThanOrEqual(41);
    expect(short).toContain('harbour-lighthouse');
    expect(short.startsWith('…/')).toBe(true);
  });

  it('does not drop a single long segment it cannot shorten', () => {
    expect(shortenSlug('averyveryverylongsinglesegmentwithnoslashesatall')).toContain('averyvery');
  });
});

describe('proposal ownership', () => {
  it('keeps location decisions with the agent', () => {
    expect(proposalNeedsOwner('route')).toBe(false);
    expect(proposalNeedsOwner('ingest')).toBe(false);
  });

  it('keeps factual conflicts with the owner', () => {
    expect(proposalNeedsOwner('conflict')).toBe(true);
  });
});
