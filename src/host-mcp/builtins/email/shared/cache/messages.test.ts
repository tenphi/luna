import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeMailDb, useInMemoryMailDb } from './db.js';
import { getCachedMessage, putCachedMessage, toMailMessage, type CachedMessage } from './messages.js';

function record(overrides: Partial<CachedMessage> = {}): CachedMessage {
  return {
    mailbox: 'tester',
    gmMsgId: '18f2c4a9b0e1',
    gmThrId: '18f2c4a9b000',
    messageId: '<abc@mail.example.test>',
    internalAt: '2026-02-03T14:02:00.000Z',
    from: 'Robin Vale <robin@example.test>',
    to: ['tester@example.test'],
    cc: [],
    subject: 'Quarterly invoice',
    outgoing: false,
    bodyClean: 'The invoice is attached.',
    bodyRaw: 'The invoice is attached.\n\n> earlier message',
    removed: { quotedLines: 2, signatureLines: 0, truncatedChars: 0 },
    attachments: [{ attachmentId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 4096 }],
    ...overrides,
  };
}

beforeEach(() => {
  useInMemoryMailDb();
});

afterEach(() => {
  closeMailDb();
});

describe('message cache', () => {
  it('round-trips a message with its arrays and counts intact', () => {
    putCachedMessage(record());

    const got = getCachedMessage('tester', '18f2c4a9b0e1');

    expect(got).toEqual(record());
  });

  it('misses for another mailbox holding the same Gmail id', () => {
    putCachedMessage(record());

    expect(getCachedMessage('someone-else', '18f2c4a9b0e1')).toBeNull();
  });

  it('returns null rather than throwing for an id it has never seen', () => {
    expect(getCachedMessage('tester', 'deadbeef')).toBeNull();
  });

  it('overwrites the body on a second write without duplicating the row', () => {
    putCachedMessage(record());
    putCachedMessage(
      record({ bodyClean: 'recleaned', removed: { quotedLines: 9, signatureLines: 1, truncatedChars: 0 } }),
    );

    const got = getCachedMessage('tester', '18f2c4a9b0e1');

    expect(got?.bodyClean).toBe('recleaned');
    expect(got?.removed.quotedLines).toBe(9);
  });

  it('survives a removed_json written by an older shape', () => {
    putCachedMessage(record());
    useInMemoryMailDb();
    // Simulate a row from before truncatedChars existed.
    putCachedMessage(record({ removed: { quotedLines: 3 } as never }));

    expect(getCachedMessage('tester', '18f2c4a9b0e1')?.removed).toEqual({
      quotedLines: 3,
      signatureLines: 0,
      truncatedChars: 0,
    });
  });
});

describe('toMailMessage', () => {
  it('takes unread from the live fetch, never from the cached row', () => {
    const message = toMailMessage(record(), 'tester:18f2c4a9b0e1', 'tester:18f2c4a9b000', true);

    expect(message.unread).toBe(true);
    expect(message.direction).toBe('incoming');
  });

  it('maps an outgoing row to the outgoing direction', () => {
    expect(toMailMessage(record({ outgoing: true }), 'a:1', 'a:2', false).direction).toBe('outgoing');
  });
});
