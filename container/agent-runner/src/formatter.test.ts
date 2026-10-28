
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import type { InMemorySessionClient } from './session/client.js';
import { getPendingMessages } from './db/messages-in.js';
import {
  extractReplyEvidence,
  extractRouting,
  extractUserText,
  formatMessages,
  stripInternalTags,
} from './formatter.js';
import { TIMEZONE } from './timezone.js';

let client: InMemorySessionClient;

beforeEach(() => {
  client = installTestSessionClient();
});

afterEach(() => {
  resetTestSessionClient();
});

function insertMessage(id: string, kind: string, content: object, opts?: { timestamp?: string }) {
  client.seedInbound({
    id,
    kind,
    content: JSON.stringify(content),
    timestamp: opts?.timestamp ?? new Date().toISOString(),
  });
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(await getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });

  /**
   * The date is the only explicit "today" in the whole prompt. A `<webhook>` or
   * `<system_response>` wake-up carries no `time=` attribute anywhere, so without
   * this the agent has nothing to resolve "yesterday" against on those turns.
   */
  it("carries today's date and weekday", () => {
    // 2026-08-04 12:00 UTC — comfortably mid-day in every zone, so the calendar
    // date is the same whether TZ resolved to the install zone or fell back to UTC.
    const result = formatMessages([], new Date('2026-08-04T12:00:00Z'));
    expect(result).toContain('date="2026-08-04"');
    expect(result).toContain('weekday="Tuesday"');
  });

  it('stays a single self-closing tag the header regex can strip', () => {
    // CONTEXT_HEADER_RE in episodes/format.ts is /^<context\b[^>]*\/>\s*/ — it
    // tolerates new attributes but not a nested element or a separate close tag.
    const result = formatMessages([], new Date('2026-08-04T12:00:00Z'));
    expect(result).toMatch(/^<context\b[^>]*\/>\s*/);
    expect(result).not.toContain('</context>');
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(await getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(await getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', async () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(await getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', async () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(await getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', async () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(await getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', async () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', async () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', async () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe('The answer is 42');
  });
});

describe('extractUserText', () => {
  it('returns the typed text without the XML envelope', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: '  and what about the flights?  ' });
    expect(extractUserText(await getPendingMessages())).toBe('and what about the flights?');
  });

  it('joins a batch and ignores tasks, webhooks, and empty bodies', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Alice', text: '' });
    insertMessage('m3', 'task', { text: 'scheduled digest' });
    insertMessage('m4', 'chat-sdk', { sender: 'Alice', text: 'two' });
    expect(extractUserText(await getPendingMessages())).toBe('one\ntwo');
  });

  it('returns nothing for a file sent with no caption', async () => {
    // The precondition the whole attachment-intake stage exists for: with no
    // words to read, the topic decision and the recall query have to get the
    // file's content from somewhere else (see attachment-digest.ts).
    insertMessage('m1', 'chat-sdk', {
      sender: 'Ada',
      text: '',
      attachments: [{ type: 'document', name: '123456789.pdf', localPath: 'inbox/m1/123456789.pdf' }],
    });
    expect(extractUserText(await getPendingMessages())).toBe('');
  });
});

describe('quoted attachments', () => {
  it('labels a file that came from the message being replied to', async () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'Ada',
      text: 'save in memory',
      replyTo: { id: '42:8', sender: 'Ada', text: '' },
      attachments: [
        { type: 'file', name: 'fixture-contract.pdf', localPath: 'inbox/m1/fixture-contract.pdf', quoted: true },
      ],
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain(
      '[file: fixture-contract.pdf (from the quoted message) — saved to /workspace/inbox/m1/fixture-contract.pdf]',
    );
  });
});

describe('forwarded messages', () => {
  it('marks the message and names the original author', async () => {
    insertMessage('m1', 'chat', {
      sender: 'Ada',
      text: 'Your booking reference is: ABC123',
      forwardedFrom: { from: 'Bo Winters', date: '2031-04-02T00:00:00.000Z' },
    });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('forwarded="true"');
    expect(result).toContain('forwarded_from="Bo Winters"');
    expect(result).toContain('forwarded_at="');
  });

  it('still marks a forward whose author is hidden', async () => {
    insertMessage('m1', 'chat', { sender: 'Ada', text: 'see this', forwardedFrom: {} });
    const result = formatMessages(await getPendingMessages());
    expect(result).toContain('forwarded="true"');
    expect(result).not.toContain('forwarded_from=');
  });

  it('leaves an ordinary message unmarked', async () => {
    insertMessage('m1', 'chat', { sender: 'Ada', text: 'my own words' });
    expect(formatMessages(await getPendingMessages())).not.toContain('forwarded');
  });
});

describe('extractReplyEvidence', () => {
  it('returns the quoted message so topic detection can place the turn', async () => {
    insertMessage('m1', 'chat', {
      sender: 'Ada',
      text: 'in russian?',
      replyTo: { id: '4021', sender: 'Luna', text: 'It looks like a tulip arrangement.' },
    });
    expect(extractReplyEvidence(await getPendingMessages())).toEqual({
      id: '4021',
      sender: 'Luna',
      text: 'It looks like a tulip arrangement.',
    });
  });

  it('returns undefined when nothing in the batch was a reply', async () => {
    insertMessage('m1', 'chat', { sender: 'Ada', text: 'in russian?' });
    insertMessage('m2', 'task', { text: 'scheduled digest' });
    expect(extractReplyEvidence(await getPendingMessages())).toBeUndefined();
  });

  it('takes the last reply in a batch — that is where the turn is steering', async () => {
    insertMessage('m1', 'chat', { sender: 'Ada', text: 'this one', replyTo: { id: '1', text: 'first quote' } });
    insertMessage('m2', 'chat', { sender: 'Ada', text: 'no, this', replyTo: { id: '2', text: 'second quote' } });
    expect(extractReplyEvidence(await getPendingMessages())?.text).toBe('second quote');
  });

  it('keeps a reply link the platform gave without any quoted text', async () => {
    insertMessage('m1', 'chat', { sender: 'Ada', text: 'in russian?', replyTo: { id: 4021 } });
    expect(extractReplyEvidence(await getPendingMessages())).toEqual({ id: '4021', text: '' });
  });
});

describe('extractRouting senderIsPrivileged', () => {
  it('reads _luna.senderIsPrivileged from message content', async () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi', _luna: { senderIsPrivileged: true } });
    const routing = extractRouting(await getPendingMessages());
    expect(routing.senderIsPrivileged).toBe(true);
  });

  it('defaults senderIsPrivileged to false when absent', async () => {
    insertMessage('m1', 'chat', { sender: 'Bob', text: 'hi' });
    const routing = extractRouting(await getPendingMessages());
    expect(routing.senderIsPrivileged).toBe(false);
  });

  it('reads the hot-memory slug the host stamped', async () => {
    insertMessage('m1', 'chat', {
      text: 'hi',
      author: { userId: '123', userName: 'ada_marlow', fullName: 'Ada' },
      _luna: { hotMemorySlug: 'users/ada' },
    });
    const routing = extractRouting(await getPendingMessages());
    expect(routing.hotMemorySlug).toBe('users/ada');
  });

  it('does not derive a slug from the platform handle', async () => {
    // The page is named for the person's key in config/local.jsonc, which the container has no view
    // of. Deriving `users/ada_marlow` from the @handle — as this used to — meant the container and the
    // host disagreed about which page was the speaker's.
    insertMessage('m1', 'chat', {
      text: 'hi',
      author: { userId: '123', userName: 'ada_marlow', fullName: 'Ada' },
    });
    const routing = extractRouting(await getPendingMessages());
    expect(routing.hotMemorySlug).toBeNull();
  });
});
