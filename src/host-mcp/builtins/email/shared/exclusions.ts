import type { Mailbox } from './types.js';

/** Operator configuration is literal data, never Gmail query syntax. */
export function exclusionList(value: unknown, kind: 'labels' | 'senders'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100)
    throw new Error(`ignore ${kind} must be an array of at most 100 values`);
  return [
    ...new Set(
      value.map((entry) => {
        if (
          typeof entry !== 'string' ||
          !entry.trim() ||
          entry.length > 200 ||
          /[\r\n]/.test(entry) ||
          entry.includes('\0')
        )
          throw new Error(`invalid ignored ${kind} value`);
        const cleaned = entry.trim();
        if (kind === 'senders' && !/^[^\s<>"()]+@[^\s<>"()]+\.[^\s<>"()]+$/.test(cleaned))
          throw new Error('ignored senders must be complete email addresses');
        return kind === 'senders' ? cleaned.toLowerCase() : cleaned;
      }),
    ),
  ];
}

/** Check current message metadata before any body or cached content can be exposed. */
export function isExcluded(mailbox: Mailbox, senders: string[], labels: Iterable<string>): boolean {
  const ignored = new Set(mailbox.ignoreSenders ?? []);
  return (
    senders.some((sender) => ignored.has(sender.toLowerCase())) ||
    [...labels].some((label) => (mailbox.ignoreLabels ?? []).includes(label))
  );
}

/** Encode every literal, including punctuation and spaces, as one Gmail term. */
export function gmailExclusions(mailbox: Pick<Mailbox, 'ignoreLabels' | 'ignoreSenders'>): string {
  const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    ...(mailbox.ignoreLabels ?? []).map((label) => `-label:${quoted(label)}`),
    ...(mailbox.ignoreSenders ?? []).map((sender) => `-from:${quoted(sender)}`),
  ].join(' ');
}
