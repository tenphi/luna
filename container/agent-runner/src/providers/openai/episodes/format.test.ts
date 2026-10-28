import { describe, expect, it } from 'bun:test';

import type { ChatMessage } from '../types.js';
import {
  clipChars,
  countUserTurns,
  deterministicTitle,
  episodeTranscript,
  historyExcerpt,
  isInjectedBlock,
  relativeWhen,
  sanitizeTitle,
  stripAttachmentAnnotations,
  unwrapUserText,
} from './format.js';

/** How the formatter actually hands a user message to the provider. */
function wrapped(text: string, seq = 1): string {
  return (
    '<context timezone="Europe/Berlin" />\n' +
    `<message id="${seq}" sender="cli" time="27 Jul 2026, 11:00">${text}</message>`
  );
}

describe('unwrapUserText', () => {
  it('pulls the body out of the message envelope', () => {
    expect(unwrapUserText(wrapped("let&apos;s plan Blackwater Bay"))).toBe("let&apos;s plan Blackwater Bay");
    expect(unwrapUserText(wrapped('and what about the flights?'))).toBe('and what about the flights?');
  });

  it('unescapes XML entities and joins a batch', () => {
    const batch = `${wrapped('a &amp; b', 1)}\n<message id="2" sender="cli" time="t">c &lt;d&gt;</message>`;
    expect(unwrapUserText(batch)).toBe('a & b\nc <d>');
  });

  it('drops a bare context header when there is no message block', () => {
    expect(unwrapUserText('<context timezone="Europe/Berlin" />\nplain text')).toBe('plain text');
  });
});

describe('stripAttachmentAnnotations', () => {
  it('drops the formatter annotation, leaving the caption', () => {
    const body = 'is this right?\n[document: bill.pdf — saved to /workspace/inbox/m-42/bill.pdf]';
    expect(stripAttachmentAnnotations(body)).toBe('is this right?');
  });

  it('leaves nothing behind for a caption-less attachment', () => {
    // A container path is noise in a topic title and in a semantic recall query;
    // what the file says arrives as attachment evidence instead.
    const body = '[image: IMG_4021.jpg — shown above; stored at /workspace/inbox/m-1/IMG_4021.jpg (pass that path to attach_files to keep it; do not Read it)]';
    expect(stripAttachmentAnnotations(body)).toBe('');
  });

  it('handles several annotations and every type the formatter emits', () => {
    const body = '[document: a.pdf — saved to /x/a.pdf]\n[voice: note.ogg]\n[video: clip.mp4 (https://e.example/c)]\nlook';
    expect(stripAttachmentAnnotations(body)).toBe('look');
  });

  it('leaves ordinary bracketed prose alone', () => {
    expect(stripAttachmentAnnotations('the invoice [see attached] is wrong')).toBe('the invoice [see attached] is wrong');
    expect(stripAttachmentAnnotations('array[0]: nine')).toBe('array[0]: nine');
  });
});

describe('isInjectedBlock', () => {
  it('recognizes recall, agendas, and non-chat wake-ups', () => {
    for (const tag of [
      '<memory>facts</memory>',
      '<hot-memory>x</hot-memory>',
      '<calendar-agenda days="14">x</calendar-agenda>',
      '<reminders-agenda list="Household">x</reminders-agenda>',
      '<conversation_summary>x</conversation_summary>',
      '<recent-conversations>x</recent-conversations>',
      // Nobody said the ledger either. Missing it would count the block as a user
      // turn and hand the topic classifier a wall of dated lines as "what the
      // user last said" — the same bug the calendar agenda caused.
      '<timeline from="2026-05-06" to="2026-08-04">2026-08-02 | x</timeline>',
      '<task time="t">run</task>',
      '<webhook source="s" event="e">{}</webhook>',
      '<system_response action="a" status="ok">null</system_response>',
    ]) {
      expect(isInjectedBlock(tag)).toBe(true);
    }
  });

  it('sees past the context header the formatter puts on every prompt', () => {
    expect(
      isInjectedBlock('<context timezone="Europe/Berlin" />\n<task time="t">Instructions: remind</task>'),
    ).toBe(true);
    expect(isInjectedBlock('<context timezone="Europe/Berlin" />\n<memory>facts</memory>')).toBe(true);
  });

  it('recognizes the memory-file view label', () => {
    expect(isInjectedBlock('[Viewed from memory: floorplan.jpg]')).toBe(true);
  });

  it('does not treat a wrapped user message as injected', () => {
    expect(isInjectedBlock(wrapped('hello'))).toBe(false);
    expect(isInjectedBlock(`<context timezone="Europe/Berlin" />\n${wrapped('hello')}`)).toBe(false);
  });
});

describe('countUserTurns', () => {
  it('counts wrapped user messages and ignores injected blocks', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '<calendar-agenda days="14">…</calendar-agenda>' },
      { role: 'user', content: wrapped('what time is sunset?') },
      { role: 'assistant', content: '21:40' },
      { role: 'user', content: '<memory>background</memory>' },
      { role: 'user', content: wrapped('and tomorrow?', 2) },
    ];

    expect(countUserTurns(history)).toBe(2);
  });
});

describe('episodeTranscript', () => {
  it('renders plain conversation lines without envelopes or agendas', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '<calendar-agenda days="14">busy</calendar-agenda>' },
      { role: 'user', content: wrapped('what time is sunset?') },
      { role: 'assistant', content: 'About 21:40.' },
      { role: 'tool', content: 'tool output' } as ChatMessage,
    ];

    expect(episodeTranscript(history)).toBe('user: what time is sunset?\nassistant: About 21:40.');
  });

  it('keeps the tail when over budget', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: wrapped('old question') },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: wrapped('new question', 2) },
    ];

    const out = episodeTranscript(history, 30);

    expect(out).toContain('new question');
    expect(out).not.toContain('old question');
  });
});

describe('clipChars', () => {
  it('never leaves half an emoji behind', () => {
    const text = `${'a'.repeat(20)}🌦️ rain`;
    // Cutting at 21 would split the surrogate pair.
    expect(clipChars(text, 21)).toBe('a'.repeat(20));
    expect(clipChars(text, 22)).toBe(`${'a'.repeat(20)}🌦`);
    expect(clipChars('short', 99)).toBe('short');
  });
});

describe('historyExcerpt', () => {
  it('unwraps user turns and keeps the last N exchanges', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: wrapped('first') },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: wrapped('second', 2) },
      { role: 'assistant', content: 'two' },
    ];

    expect(historyExcerpt(history, 1)).toBe('user: second\nassistant: two');
  });

  it('truncates a long turn without splitting an emoji', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: wrapped('weather?') },
      { role: 'assistant', content: `${'x'.repeat(239)}🌦️ later` },
    ];

    const excerpt = historyExcerpt(history, 1, 240);
    expect(excerpt.endsWith(`${'x'.repeat(239)}…`)).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(excerpt)).toBe(false);
  });
});

describe('deterministicTitle', () => {
  it('names a topic from the first clause, stripping openers', () => {
    expect(deterministicTitle("let's plan a trip to Blackwater Bay in September")).toBe(
      'Plan a trip to Blackwater Bay in September',
    );
  });

  it('drops the link and the separator it left behind', () => {
    expect(
      deterministicTitle(
        'I want to buy this field bag - https://example.com/products/field-bag\nIs it worth it?',
      ),
    ).toBe('Buy this field bag');
  });

  it('names a link-only message after its host', () => {
    expect(deterministicTitle('https://example.com/products/field-bag')).toBe('example.com');
  });

  it('stops at the first line', () => {
    expect(deterministicTitle('Garden hoses\nWhich one should I get?')).toBe('Garden hoses');
  });
});

describe('sanitizeTitle', () => {
  it('clips on a word boundary rather than mid-token', () => {
    const title = sanitizeTitle('summarize this really long thing about many different subjects at once', 'fallback');
    expect(title).toBe('summarize this really long thing about many different…');
    expect(title).not.toContain('differen…');
  });

  it('leaves a short title untouched', () => {
    expect(sanitizeTitle('Field bag purchase', 'fallback')).toBe('Field bag purchase');
  });

  it('falls back when the model answered with the decision', () => {
    expect(sanitizeTitle('new', 'fallback')).toBe('fallback');
  });
});

describe('relativeWhen', () => {
  it('reads as a human would say it', () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    expect(relativeWhen('2026-07-27T11:59:30.000Z', now)).toBe('just now');
    expect(relativeWhen('2026-07-27T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeWhen('2026-07-26T23:00:00.000Z', now)).toBe('yesterday');
    expect(relativeWhen('2026-06-12T10:00:00.000Z', now)).toBe('Jun 12');
    expect(relativeWhen('not a date', now)).toBe('earlier');
  });
});
