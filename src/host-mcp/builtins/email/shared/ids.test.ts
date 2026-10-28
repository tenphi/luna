import { describe, expect, it } from 'vitest';

import { decodeMailId, encodeMailId, fromGmailNumeric, MailIdError, toGmailNumeric } from './ids.js';

describe('encodeMailId', () => {
  it('round-trips through decode', () => {
    const id = encodeMailId('ada', '18f2c4a9b0e1');

    expect(id).toBe('ada:18f2c4a9b0e1');
    expect(decodeMailId(id)).toEqual({ mailbox: 'ada', gmailId: '18f2c4a9b0e1' });
  });

  it('accepts a bigint and lowercases hex', () => {
    expect(encodeMailId('bo', 0x18f2c4a9b0e1n)).toBe('bo:18f2c4a9b0e1');
    expect(encodeMailId('bo', '18F2C4A9B0E1')).toBe('bo:18f2c4a9b0e1');
  });

  it('refuses a mailbox key that would make the id ambiguous', () => {
    expect(() => encodeMailId('a:b', '18f2')).toThrow(MailIdError);
  });
});

describe('decodeMailId', () => {
  it('rejects an id with no mailbox half', () => {
    expect(() => decodeMailId('18f2c4a9b0e1')).toThrow(MailIdError);
    expect(() => decodeMailId(':18f2')).toThrow(MailIdError);
    expect(() => decodeMailId('ada:')).toThrow(MailIdError);
  });

  it('rejects a Gmail web URL, which is the plausible wrong thing to pass', () => {
    expect(() => decodeMailId('https://mail.google.com/mail/u/0/#inbox/FMfcg')).toThrow(MailIdError);
  });

  it('rejects a malformed Gmail id', () => {
    expect(() => decodeMailId('ada:not-hex')).toThrow(MailIdError);
  });

  it('rejects an id naming a mailbox this install does not have, and lists the ones it does', () => {
    expect(() => decodeMailId('nobody:18f2', ['ada', 'bo'])).toThrow(/ada, bo/);
  });

  it('accepts a known mailbox when the list is supplied', () => {
    expect(decodeMailId('bo:18f2', ['ada', 'bo']).mailbox).toBe('bo');
  });
});

describe('Gmail numeric conversion', () => {
  it('round-trips hex and the decimal form IMAP reports', () => {
    const decimal = '1712345678901234567';

    expect(toGmailNumeric(fromGmailNumeric(decimal))).toBe(decimal);
  });

  it('survives ids past 2^53, where a number would lose precision', () => {
    const decimal = '9007199254740993';

    expect(toGmailNumeric(fromGmailNumeric(decimal))).toBe(decimal);
  });
});
