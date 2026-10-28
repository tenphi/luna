import { describe, expect, it } from 'vitest';
import { exclusionList, gmailExclusions, isExcluded } from './exclusions.js';

describe('mail exclusions', () => {
  it('matches actual addresses and exact labels, never sender display names', () => {
    const policy = {
      key: 'ada',
      address: 'ada@example.test',
      displayName: null,
      appPassword: 'fixture',
      ignoreLabels: ['Work'],
      ignoreSenders: ['notice@example.test'],
    };
    expect(isExcluded(policy, ['NOTICE@EXAMPLE.TEST'], [])).toBe(true);
    expect(isExcluded(policy, ['other@example.test'], ['Work'])).toBe(true);
    expect(isExcluded(policy, ['notice@example.test.attacker.test'], ['Homework'])).toBe(false);
  });

  it('validates literal configuration and normalizes sender addresses', () => {
    expect(exclusionList([' Notice@Example.test ', 'notice@example.test'], 'senders')).toEqual(['notice@example.test']);
    expect(() => exclusionList(['from:x OR in:anywhere'], 'senders')).toThrow();
    expect(() => exclusionList(['Work\nOther'], 'labels')).toThrow();
    expect(gmailExclusions({ ignoreLabels: ['Work updates'], ignoreSenders: ['notice@example.test'] })).toBe(
      '-label:"Work updates" -from:"notice@example.test"',
    );
  });
});
