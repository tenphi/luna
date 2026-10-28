import { describe, expect, it } from 'vitest';

import { stripQuotes } from './quotes.js';

describe('stripQuotes', () => {
  it('cuts at a Gmail attribution line and counts what went', () => {
    const body = [
      'Yes, Tuesday works.',
      '',
      'On Mon, 3 Feb 2026 at 14:02, Robin Vale <robin@example.test> wrote:',
      '> Can you do Tuesday?',
      '> Robin',
    ].join('\n');

    const result = stripQuotes(body);

    expect(result.text).toBe('Yes, Tuesday works.');
    expect(result.quotedLines).toBe(3);
  });

  it('cuts an attribution that wrapped across two lines', () => {
    const body = [
      'Confirmed.',
      '',
      'On Mon, 3 Feb 2026 at 14:02,',
      'Robin Vale <robin@example.test> wrote:',
      '> ping',
    ].join('\n');

    expect(stripQuotes(body).text).toBe('Confirmed.');
  });

  it('cuts an Outlook header block but not a bare From: line', () => {
    const quoted = [
      'Looks fine.',
      '',
      'From: Robin Vale',
      'Sent: Monday, 3 February 2026 14:02',
      'To: Sam',
      '',
      'Original text',
    ].join('\n');
    expect(stripQuotes(quoted).text).toBe('Looks fine.');

    const prose = [
      'From: the desk of nobody in particular',
      '',
      'This is the actual message body and it keeps going.',
    ].join('\n');
    expect(stripQuotes(prose).text).toBe(prose);
    expect(stripQuotes(prose).quotedLines).toBe(0);
  });

  it('keeps an inline quote that the message continues past', () => {
    const body = ['You wrote:', '> the deadline is the 5th', '', 'That is wrong — it is the 6th.'].join('\n');

    const result = stripQuotes(body);

    expect(result.text).toContain('That is wrong');
    expect(result.quotedLines).toBe(0);
  });

  it('cuts a trailing quoted run that reaches the end', () => {
    const body = ['Agreed.', '', '> the deadline is the 5th', '> and the venue is booked'].join('\n');

    const result = stripQuotes(body);

    expect(result.text).toBe('Agreed.');
    expect(result.quotedLines).toBe(2);
  });

  it('cuts a signature only when it is actually the tail', () => {
    const tail = ['Sounds good.', '', '-- ', 'Robin Vale', 'Example Ltd'].join('\n');
    const stripped = stripQuotes(tail);
    expect(stripped.text).toBe('Sounds good.');
    expect(stripped.signatureLines).toBe(3);

    const midway = ['Intro line.', '-- ', ...Array.from({ length: 20 }, (_, i) => `content line ${i}`)].join('\n');
    expect(stripQuotes(midway).signatureLines).toBe(0);
  });

  it('reports nothing removed for a message with no quoting', () => {
    const result = stripQuotes('Just a short note.');

    expect(result).toEqual({ text: 'Just a short note.', quotedLines: 0, signatureLines: 0 });
  });
});
