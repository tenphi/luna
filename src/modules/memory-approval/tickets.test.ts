import { beforeEach, describe, expect, it } from 'vitest';

import { clearProposalTickets, grantProposalTicket, spendProposalTicket } from './tickets.js';

const GROUP = 'luna-default';

beforeEach(() => {
  clearProposalTickets();
});

describe('proposal tickets', () => {
  it('refuses a proposal nobody delegated', () => {
    // The default: `approve` is not the agent's to call, so an id it merely knows buys nothing.
    expect(spendProposalTicket('prop_fd74e0f2', GROUP)).toBe(false);
  });

  it('lets the delegated proposal through once', () => {
    grantProposalTicket('prop_fd74e0f2', GROUP);
    expect(spendProposalTicket('prop_fd74e0f2', GROUP)).toBe(true);
  });

  it('is spent on first use, so a repeat cannot file the held claim twice', () => {
    grantProposalTicket('prop_fd74e0f2', GROUP);
    expect(spendProposalTicket('prop_fd74e0f2', GROUP)).toBe(true);
    expect(spendProposalTicket('prop_fd74e0f2', GROUP)).toBe(false);
  });

  it('does not carry to another proposal', () => {
    grantProposalTicket('prop_fd74e0f2', GROUP);
    expect(spendProposalTicket('prop_e73f0a16', GROUP)).toBe(false);
    expect(spendProposalTicket('prop_fd74e0f2', GROUP)).toBe(true);
  });

  it('does not carry to another agent group', () => {
    grantProposalTicket('prop_fd74e0f2', GROUP);
    expect(spendProposalTicket('prop_fd74e0f2', 'someone-else')).toBe(false);
  });

  it('refuses a caller with no authenticated group', () => {
    grantProposalTicket('prop_fd74e0f2', GROUP);
    expect(spendProposalTicket('prop_fd74e0f2', '')).toBe(false);
  });
});
