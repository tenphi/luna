import { describe, expect, it, vi } from 'vitest';

import { hydrateReplyContextContent } from './router.js';

describe('hydrateReplyContextContent', () => {
  it('fills empty replyTo.text from lookup', () => {
    const lookup = vi.fn().mockReturnValue({ text: 'Quoted original', sender: 'Luna' });
    const input = JSON.stringify({
      text: 'Then what does this mean?',
      replyTo: { text: '', sender: 'Luna', id: '1000000001:6634' },
    });

    const out = JSON.parse(hydrateReplyContextContent(input, lookup));
    expect(lookup).toHaveBeenCalledWith('1000000001:6634');
    expect(out.replyTo).toEqual({
      text: 'Quoted original',
      sender: 'Luna',
      id: '1000000001:6634',
    });
  });

  it('does not overwrite existing quote text', () => {
    const lookup = vi.fn().mockReturnValue({ text: 'from db' });
    const input = JSON.stringify({
      text: 'follow up',
      replyTo: { text: 'already here', sender: 'Bob', id: '1:2' },
    });

    const out = JSON.parse(hydrateReplyContextContent(input, lookup));
    expect(lookup).not.toHaveBeenCalled();
    expect(out.replyTo.text).toBe('already here');
  });

  it('skips when replyTo has no id', () => {
    const lookup = vi.fn();
    const input = JSON.stringify({
      text: 'hi',
      replyTo: { text: '', sender: 'Luna' },
    });
    expect(hydrateReplyContextContent(input, lookup)).toBe(input);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fills sender from lookup when missing', () => {
    const lookup = vi.fn().mockReturnValue({ text: 'body', sender: 'Ada' });
    const input = JSON.stringify({
      text: '?',
      replyTo: { text: '', id: '1000000001:1' },
    });
    const out = JSON.parse(hydrateReplyContextContent(input, lookup));
    expect(out.replyTo).toEqual({ text: 'body', sender: 'Ada', id: '1000000001:1' });
  });
});
