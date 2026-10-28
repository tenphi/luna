import { describe, expect, it } from 'vitest';

import { budgetBody } from './budget.js';

const ID = 'ada:18f2c4a9b0e1';

describe('budgetBody', () => {
  it('leaves a body under budget untouched', () => {
    const result = budgetBody('short', 100, ID);

    expect(result).toEqual({ text: 'short', truncatedChars: 0 });
  });

  it('names the exact call that continues the body', () => {
    const body = 'x'.repeat(500);

    const result = budgetBody(body, 100, ID);

    expect(result.text).toContain(`read_message({ id: "${ID}", offset: 100 })`);
    expect(result.truncatedChars).toBe(400);
  });

  it('carries the offset forward so a second page continues rather than repeats', () => {
    const body = 'y'.repeat(500);

    const result = budgetBody(body, 100, ID, 100);

    expect(result.text).toContain('offset: 200');
  });

  it('breaks on a paragraph boundary when one is close enough', () => {
    const body = `${'a'.repeat(90)}\n\n${'b'.repeat(200)}`;

    const result = budgetBody(body, 100, ID);

    const kept = result.text.slice(0, result.text.indexOf('\n\n['));
    expect(kept).toBe('a'.repeat(90));
  });

  it('cuts at the limit rather than losing most of the budget to a distant boundary', () => {
    // The only newline sits far below the 80% floor, so chasing it would waste the budget.
    const body = `ab\n${'c'.repeat(500)}`;

    const result = budgetBody(body, 100, ID);

    expect(result.text.length).toBeGreaterThan(90);
  });

  it('reports the omitted count that the marker advertises', () => {
    const body = 'z'.repeat(1000);

    const result = budgetBody(body, 400, ID);

    expect(result.text).toContain(result.truncatedChars.toLocaleString('en-US'));
  });
});
