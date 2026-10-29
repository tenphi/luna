import { describe, expect, it } from 'vitest';

import { isLink, joinNotes, normalizeLink, stripLink, updatedNotes } from './notes-link.js';

const tickets = 'https://blackwater-bay.example/tickets/2031';
const venue = 'https://blackwater-bay.example/venue';

describe('isLink / normalizeLink', () => {
  it('accepts absolute URLs and rejects bare domains', () => {
    expect(isLink(tickets)).toBe(true);
    expect(isLink(' mailto:ada@vulpine.example ')).toBe(true);
    expect(isLink('blackwater-bay.example/tickets')).toBe(false);
    expect(isLink('')).toBe(false);
  });

  it('percent-encodes what EventKit would otherwise drop', () => {
    expect(normalizeLink(' https://blackwater-bay.example/a b ')).toBe('https://blackwater-bay.example/a%20b');
    expect(() => normalizeLink('tickets page')).toThrow(/Invalid url/);
  });
});

describe('joinNotes', () => {
  it('appends the link on its own line after the body', () => {
    expect(joinNotes('Bring the printed receipt.\n', tickets)).toBe(`Bring the printed receipt.\n\n${tickets}`);
  });

  it('uses the link alone when there is no body', () => {
    expect(joinNotes(undefined, tickets)).toBe(tickets);
    expect(joinNotes('', tickets)).toBe(tickets);
  });

  it('does not repeat a link the body already carries', () => {
    expect(joinNotes(`Tickets: ${tickets} (two seats)`, tickets)).toBe(`Tickets: ${tickets} (two seats)`);
    expect(joinNotes('See https://blackwater-bay.example/a%20b', 'https://blackwater-bay.example/a b')).toBe(
      'See https://blackwater-bay.example/a%20b',
    );
  });

  it('leaves the body untouched without a link', () => {
    expect(joinNotes('Call Bo first.  ', undefined)).toBe('Call Bo first.  ');
    expect(joinNotes(undefined, null)).toBeNull();
  });
});

describe('stripLink', () => {
  it('drops the appended line and its separator', () => {
    expect(stripLink(`Bring the printed receipt.\n\n${tickets}\n`, tickets)).toBe('Bring the printed receipt.');
    expect(stripLink(tickets, tickets)).toBeNull();
  });

  it('matches the canonical form EventKit reports', () => {
    expect(stripLink('Note\n\nhttps://blackwater-bay.example/a b', 'https://blackwater-bay.example/a%20b')).toBe(
      'Note',
    );
  });

  it('keeps a link that is part of the text', () => {
    expect(stripLink(`Tickets: ${tickets}\nCall Bo first.`, tickets)).toBe(`Tickets: ${tickets}\nCall Bo first.`);
  });
});

describe('updatedNotes', () => {
  const current = { notes: `Two seats.\n\n${tickets}`, url: tickets };

  it('is undefined when neither body nor url changes', () => {
    expect(updatedNotes(current, {})).toBeUndefined();
  });

  it('replaces the appended link', () => {
    expect(updatedNotes(current, { url: venue })).toBe(`Two seats.\n\n${venue}`);
  });

  it('removes the appended link when the url is cleared', () => {
    expect(updatedNotes(current, { url: null })).toBe('Two seats.');
    expect(updatedNotes({ notes: tickets, url: tickets }, { url: null })).toBeNull();
  });

  it('keeps the link when the body is rewritten or cleared', () => {
    expect(updatedNotes(current, { body: 'Four seats.' })).toBe(`Four seats.\n\n${tickets}`);
    expect(updatedNotes(current, { body: `Four seats.\n\n${tickets}` })).toBe(`Four seats.\n\n${tickets}`);
    expect(updatedNotes(current, { body: null })).toBe(tickets);
  });

  it('surfaces a link that lived only in the hidden url field', () => {
    expect(updatedNotes({ notes: 'Two seats.', url: tickets }, { body: 'Four seats.' })).toBe(
      `Four seats.\n\n${tickets}`,
    );
    expect(updatedNotes({ notes: null, url: tickets }, { url: tickets })).toBe(tickets);
  });
});
