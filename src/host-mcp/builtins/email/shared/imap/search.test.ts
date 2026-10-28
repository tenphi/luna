import { describe, expect, it } from 'vitest';

import { buildGmailQuery, dateWindow, MailQueryError } from './search.js';

const base = { mailbox: 'ada', limit: 20 };

describe('buildGmailQuery', () => {
  it('excludes spam, trash and drafts even with no filters at all', () => {
    expect(buildGmailQuery(base)).toBe('-in:spam -in:trash -in:drafts');
  });

  it('keeps the exclusions no matter what the passthrough says', () => {
    const cases = [
      'in:trash',
      'in:spam OR in:trash',
      'label:x) OR (in:trash',
      '-in:spam -in:trash in:trash',
      'subject:"a" in:anywhere',
    ];

    for (const query of cases) {
      const built = buildGmailQuery({ ...base, query });
      expect(built.endsWith('-in:spam -in:trash -in:drafts')).toBe(true);
      // The passthrough stays inside its own group, so it cannot append operators after it.
      expect(built).toContain(`(${query})`);
    }
  });

  it('uses exact inclusive UTC days through epoch boundaries', () => {
    const built = buildGmailQuery({ ...base, since: '2026-02-03', until: '2026-02-03' }, 'UTC');

    expect(built).toContain(`after:${Date.parse('2026-02-03T00:00:00Z') / 1000 - 1}`);
    expect(built).toContain(`before:${Date.parse('2026-02-04T00:00:00Z') / 1000}`);
  });

  it('crosses a month boundary correctly', () => {
    expect(buildGmailQuery({ ...base, until: '2026-02-28' }, 'UTC')).toContain(
      `before:${Date.parse('2026-03-01T00:00:00Z') / 1000}`,
    );
  });

  it('rejects a date that is not a day', () => {
    expect(() => buildGmailQuery({ ...base, since: 'yesterday' })).toThrow(MailQueryError);
  });

  it.each(['2026-02-30', '2026-13-01', 'not-a-day'])('rejects invalid calendar date %s', (since) => {
    expect(() => dateWindow({ since }, 'UTC')).toThrow(MailQueryError);
  });

  it('rejects an inverted interval', () => {
    expect(() => dateWindow({ since: '2026-03-02', until: '2026-03-01' }, 'UTC')).toThrow(MailQueryError);
  });

  it.each([
    ['2026-03-29', 23],
    ['2026-10-25', 25],
    ['2026-10-06', 24],
  ])('covers local DST day %s completely', (day, hours) => {
    const { start, end } = dateWindow({ since: day, until: day }, 'Europe/Berlin');
    expect((end! - start!) / 3600).toBe(hours);
    expect(new Date(start! * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' })).toBe(day);
  });

  it('maps direction onto in:sent', () => {
    expect(buildGmailQuery({ ...base, direction: 'outgoing' })).toContain('in:sent');
    expect(buildGmailQuery({ ...base, direction: 'incoming' })).toContain('-in:sent');
    expect(buildGmailQuery({ ...base, direction: 'any' })).toBe('-in:spam -in:trash -in:drafts');
  });

  it('quotes a multi-word value so it stays one term', () => {
    expect(buildGmailQuery({ ...base, subject: 'quarterly invoice' })).toContain('subject:"quarterly invoice"');
    expect(buildGmailQuery({ ...base, from: 'robin@example.test' })).toContain('from:robin@example.test');
  });

  it('strips quotes out of a value rather than letting them break the term', () => {
    expect(buildGmailQuery({ ...base, subject: 'a" in:trash "b' })).toContain('subject:"a in:trash b"');
  });

  it('combines flags', () => {
    const built = buildGmailQuery({ ...base, unreadOnly: true, hasAttachment: true });

    expect(built).toContain('is:unread');
    expect(built).toContain('has:attachment');
  });
});
