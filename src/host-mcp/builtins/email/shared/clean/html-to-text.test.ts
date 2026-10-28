import { describe, expect, it } from 'vitest';

import { collapseWhitespace, decodeEntities, htmlToText } from './html-to-text.js';

describe('htmlToText', () => {
  it('removes preview padding while preserving joiners inside actual prose', () => {
    expect(htmlToText(`<div>${'&zwnj;&nbsp;'.repeat(200)}</div><p>Pending, not paid.</p><p>a&zwnj;b</p>`).text).toBe(
      'Pending, not paid.\n\na\u200cb',
    );
  });
  it('keeps prose and link targets', () => {
    const { text } = htmlToText('<p>Invoice is <a href="https://example.test/i/42">ready to view</a>.</p>');

    expect(text).toBe('Invoice is ready to view (https://example.test/i/42).');
  });

  it('drops a link wrapper when the text already is the url', () => {
    const { text } = htmlToText('<a href="https://example.test/x">https://example.test/x</a>');

    expect(text).toBe('https://example.test/x');
  });

  it('drops script, style and tracking pixels', () => {
    const { text } = htmlToText(
      '<style>.a{color:red}</style><script>track()</script><p>Hello</p><img src="https://t.example.test/p.gif" width="1">',
    );

    expect(text).toBe('Hello');
  });

  it('keeps image alt text, which is the only readable part of an image', () => {
    const { text } = htmlToText('<p>See <img src="x.png" alt="the Q3 chart"> above.</p>');

    expect(text).toBe('See [image: the Q3 chart] above.');
  });

  it('drops a gmail_quote container and says that it did', () => {
    const result = htmlToText('<div>Yes.</div><div class="gmail_quote">Everything said before</div>');

    expect(result.text).toBe('Yes.');
    expect(result.droppedQuoteContainer).toBe(true);
  });

  it('drops a blockquote', () => {
    const result = htmlToText('<p>Agreed.</p><blockquote>the earlier message</blockquote>');

    expect(result.text).toBe('Agreed.');
    expect(result.droppedQuoteContainer).toBe(true);
  });

  it('collapses a layout table into readable lines', () => {
    const html = '<table><tr><td>One</td></tr><tr><td>Two</td></tr></table>';

    expect(htmlToText(html).text).toBe('One\n\nTwo');
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex forms', () => {
    expect(decodeEntities('a &amp; b &#233; c &#x20AC;')).toBe('a & b é c €');
  });

  it('leaves an unknown entity alone rather than eating it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

describe('collapseWhitespace', () => {
  it('collapses blank-line runs but keeps single newlines', () => {
    expect(collapseWhitespace('a\n\n\n\n\nb\nc')).toBe('a\n\nb\nc');
  });

  it('normalizes non-breaking spaces', () => {
    expect(collapseWhitespace('a  b')).toBe('a b');
  });
});
