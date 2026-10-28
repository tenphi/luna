import { describe, expect, it } from 'vitest';

import { displayFileNames } from './delivery-file-names.js';

describe('displayFileNames', () => {
  it('shows the useful name without altering the stored path', () => {
    const reply = 'I read `/workspace/inbox/m-42/bill.pdf`.';
    expect(displayFileNames(reply)).toBe('I read `bill.pdf`.');
    expect(reply).toContain('/workspace/inbox/m-42/bill.pdf');
  });

  it('distinguishes equal names in one reply', () => {
    expect(displayFileNames('Compare `/workspace/inbox/a/bill.pdf` and `/workspace/inbox/b/bill.pdf`.')).toBe(
      'Compare `bill.pdf (file 1)` and `bill.pdf (file 2)`.',
    );
  });

  it('retains the full path when explicitly requested', () => {
    const reply = 'Path: /workspace/inbox/m-42/bill.pdf';
    expect(displayFileNames(reply, 'Show me the exact path')).toBe(reply);
  });
});
