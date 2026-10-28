import { describe, expect, it } from 'vitest';
import { scheduledBatches } from './scheduled-batches.js';
import type { ScheduledEmailEvidence } from './scheduled-evidence.js';

const report = {
  item_id: 'report',
  text: 'An invented report with several distinct findings.',
  role: 'assistant' as const,
  speaker: 'Luna',
};
const email = (index: number, chars = 20_000, thread = String(index)): ScheduledEmailEvidence => ({
  item_id: `email:ada:${index}`,
  thread_id: `ada:${thread}`,
  role: 'external',
  speaker: 'Bo Winters <bo@example.test>',
  mentioned_at: '2031-04-02T18:30:00Z',
  text: `Original ${index}: ` + 'x'.repeat(chars) + '\nPending, not settled. No booking is confirmed.',
});

describe('scheduled evidence batches', () => {
  it('includes twenty complete originals once, preserving qualifiers and bounded request sizes', () => {
    const emails = Array.from({ length: 20 }, (_, index) => email(index));
    const result = scheduledBatches({ emails, omitted: 0 }, [report]);
    const originals = result.batches.flat().filter((item) => item.role === 'external');
    expect(originals).toHaveLength(20);
    expect(originals.map((item) => item.text)).toEqual(emails.map((item) => item.text));
    expect(result.batches.every((items) => JSON.stringify({ kind: 'structured', items }).length <= 110_000)).toBe(true);
    expect(result.batches.every((items) => new Set(items.map((item) => item.item_id)).size === items.length)).toBe(
      true,
    );
    expect(result.oversizedGroups).toBe(0);
  });

  it('keeps one finding and its related thread/dependencies together', () => {
    const emails = [email(1, 25_000, '10'), email(2, 25_000, '10'), email(3), email(4)];
    const result = scheduledBatches(
      { emails, omitted: 0, findings: [{ text: 'One qualified finding.', item_ids: ['email:ada:1', 'email:ada:4'] }] },
      [report],
    );
    const first = result.batches.find((items) => items.some((item) => item.item_id === 'email:ada:1'))!;
    expect(first.filter((item) => item.role === 'external').map((item) => item.item_id)).toEqual([
      'email:ada:1',
      'email:ada:2',
      'email:ada:4',
    ]);
    expect(first.some((item) => item.text === 'One qualified finding.')).toBe(true);
    expect(first.some((item) => item.item_id === 'report')).toBe(false);
  });

  it('holds an entire linked finding when one original is unavailable', () => {
    const result = scheduledBatches(
      {
        emails: [email(1), email(3)],
        omitted: 1,
        findings: [{ text: 'Depends on a missing correction.', item_ids: ['email:ada:1', 'email:ada:2'] }],
      },
      [report],
    );
    expect(result.incompleteGroups).toBe(1);
    expect(result.batches.flat().some((item) => item.item_id === 'email:ada:1')).toBe(false);
    expect(result.batches.flat().some((item) => item.item_id === 'email:ada:3')).toBe(true);
  });

  it('does not retain a report finding when all its originals are missing', () => {
    const result = scheduledBatches(
      { emails: [], omitted: 1, findings: [{ text: 'Unsupported finding.', item_ids: ['email:ada:1'] }] },
      [report],
    );
    expect(result.incompleteGroups).toBe(1);
    expect(result.batches.flat().map((item) => item.item_id)).toEqual(['evidence-unavailable']);
  });

  it('holds an oversized connected thread while preserving independent useful evidence', () => {
    const result = scheduledBatches(
      { emails: [email(1, 60_000, '10'), email(2, 60_000, '10'), email(3)], omitted: 0 },
      [report],
    );
    expect(result.oversizedGroups).toBe(1);
    expect(result.oversizedEmails).toBe(2);
    expect(
      result.batches
        .flat()
        .filter((item) => item.role === 'external')
        .map((item) => item.item_id),
    ).toEqual(['email:ada:3']);
  });
});
