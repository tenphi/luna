import { describe, expect, it } from 'vitest';
import { nestLooseSublists, normalizeTelegramMarkdown } from './telegram-markdown.js';

describe('nestLooseSublists', () => {
  it('indents unindented bullets under an ordered item', () => {
    const input = ['1. Quillpad', '- Strong markdown', '- SFTP', '', '1. Harbour Git', '- Git workflow'].join('\n');
    expect(nestLooseSublists(input)).toBe(
      ['1. Quillpad', '   - Strong markdown', '   - SFTP', '', '1. Harbour Git', '   - Git workflow'].join('\n'),
    );
  });

  it('leaves already-indented nested items alone', () => {
    const input = ['1. Quillpad', '   - Strong markdown', '2. Harbour Git', '   - Git workflow'].join('\n');
    expect(nestLooseSublists(input)).toBe(input);
  });

  it('clears nesting on blank lines so a following free bullet stays unindented', () => {
    const input = ['1. Only item', '', '- Separate section'].join('\n');
    expect(nestLooseSublists(input)).toBe(input);
  });
});

describe('normalizeTelegramMarkdown', () => {
  it('renumbers lazy flat ordered lists', () => {
    const out = normalizeTelegramMarkdown(['1. One', '1. Two', '1. Three'].join('\n'));
    expect(out).toBe(['1. One', '2. Two', '3. Three'].join('\n'));
  });

  it('renumbers screenshot-like lists with unindented sub-bullets', () => {
    const input = [
      '1. **Quillpad ( + FTP/SFTP )**',
      '- Strong markdown editing',
      '- SFTP support via SSH',
      '',
      '1. **Harbour Git (Git-focused)**',
      '- Smooth workflow for git repos over SSH',
      '',
      '1. **Inkwell / Notewell?**',
      '- Notewell can sync from remote sources',
    ].join('\n');

    const out = normalizeTelegramMarkdown(input);
    expect(out).toContain('1. **Quillpad');
    expect(out).toContain('2. **Harbour Git');
    expect(out).toContain('3. **Inkwell');
    expect(out).toMatch(/1\. \*\*Quillpad[\s\S]*?\n\s+- Strong markdown/);
    expect(out).toMatch(/2\. \*\*Harbour Git[\s\S]*?\n\s+- Smooth workflow/);
  });

  it('preserves already-correct numbered lists with indented nests', () => {
    const input = [
      '1. **Quillpad**',
      '   - Strong markdown',
      '2. **Harbour Git**',
      '   - Git workflow',
      '3. **Inkwell**',
      '   - Sync only',
    ].join('\n');

    const out = normalizeTelegramMarkdown(input);
    expect(out).toContain('1. **Quillpad**');
    expect(out).toContain('2. **Harbour Git**');
    expect(out).toContain('3. **Inkwell**');
  });

  it('leaves non-list markdown intact in substance', () => {
    const input = ['## Summary', '', 'Here is **bold** and `code`.', '', '> a quote'].join('\n');
    const out = normalizeTelegramMarkdown(input);
    expect(out).toContain('## Summary');
    expect(out).toContain('**bold**');
    expect(out).toContain('`code`');
    expect(out).toContain('> a quote');
  });

  it('returns empty / falsy input unchanged', () => {
    expect(normalizeTelegramMarkdown('')).toBe('');
  });

  it('keeps bare URLs bare instead of wrapping them in autolink brackets', () => {
    expect(normalizeTelegramMarkdown('Buy this field bag - https://example.com/products/field-bag')).toBe(
      'Buy this field bag - https://example.com/products/field-bag',
    );
    expect(normalizeTelegramMarkdown('- item https://x.com/y')).toBe('- item https://x.com/y');
  });

  it('unwraps bare emails and mailto links', () => {
    expect(normalizeTelegramMarkdown('Write to ada@example.com today')).toBe('Write to ada@example.com today');
  });

  it('leaves explicit markdown links alone', () => {
    expect(normalizeTelegramMarkdown('See [the page](https://example.com)')).toBe(
      'See [the page](https://example.com)',
    );
  });

  it('leaves angle brackets inside code untouched', () => {
    const fenced = ['```', 'curl <https://x.com>', '```'].join('\n');
    expect(normalizeTelegramMarkdown(fenced)).toBe(fenced);
    expect(normalizeTelegramMarkdown('run `curl <https://x.com>` now')).toBe('run `curl <https://x.com>` now');
  });
});
