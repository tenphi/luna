import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import {
  appendMemoryChange,
  dispatchMemoryMutation,
  isMcpError,
  isMutatingMemoryTool,
  mutatedSlug,
  mutationAction,
  readMemoryChanges,
} from './memory-mutations.js';

describe('isMcpError', () => {
  it.each([
    ['Error: nope', true],
    ['Error creating page "x": boom', true], // Luna's own helpers omit the colon
    ['MCP tool error (memory_write)', true],
    ['Unknown MCP tool: nope', true],
    ['Wrote page', false],
    // Not an error — and precisely why a move verifies the filesystem instead of
    // trusting this predicate.
    ['Page not found for slug people/jane', false],
    ['Errors were recorded in the page body', false],
  ])('%p → %p', (result, expected) => {
    expect(isMcpError(result as string)).toBe(expected);
  });
});

describe('dispatchMemoryMutation', () => {
  let client: InMemorySessionClient;
  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
  });

  const okDispatch = async () => 'Wrote page';

  it('records an applied change with a change id', async () => {
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'people/bob', content: 'x' },
      {
        gate: false,
      },
    );
    expect(result).toContain('change id: c_');
    const changes = await readMemoryChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe('edit');
    expect(changes[0]!.status).toBe('applied');
    expect(client.outbound).toHaveLength(0);
  });

  it('leaves a new top-level folder to memory, which knows the structure', async () => {
    // This used to be gated here from a directory listing the container cannot see, so the
    // guess was "every folder is new". Memory returns `requires_approval` for a write into a
    // folder that does not exist, and it is the side that actually knows.
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'travel/lisbon', content: 'x' },
      {
        gate: true,
      },
    );
    expect(result).toContain('change id: c_');
    expect(client.outbound).toHaveLength(0);
    expect((await readMemoryChanges())[0]!.status).toBe('applied');
  });

  it('hard-refuses writes to hot memory (users/*) when blockHotMemory is set', async () => {
    let dispatched = false;
    const result = await dispatchMemoryMutation(
      async () => {
        dispatched = true;
        return 'Wrote page';
      },
      'memory_write',
      { slug: 'users/alice', content: 'x' },
      { gate: true, blockHotMemory: true },
    );
    expect(result).toContain('Refusing to modify hot-memory page');
    expect(dispatched).toBe(false);
    expect(client.outbound).toHaveLength(0);
    expect(await readMemoryChanges()).toHaveLength(0);
  });

  it('allows the main agent (no blockHotMemory) to write users/*', async () => {
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'users/alice', content: 'x' },
      {
        gate: false,
      },
    );
    expect(result).toContain('change id: c_');
  });

  it('hard-refuses main-agent writes to the timeline ledger', async () => {
    // `append` lands at the bottom of a date-ordered page, and the agent used it to record its
    // own turn ("the daily review found nothing") as an event.
    let dispatched = false;
    const result = await dispatchMemoryMutation(
      async () => {
        dispatched = true;
        return 'Wrote page';
      },
      'memory_write',
      { slug: 'timeline', append: '- **2031-04-09** | the daily review found no messages.' },
      { gate: false, blockLedger: true },
    );
    expect(result).toContain('Refusing to write the timeline page directly');
    expect(dispatched).toBe(false);
    expect(await readMemoryChanges()).toHaveLength(0);
  });

  it('refuses the ledger under a filesystem-style slug too', async () => {
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'timeline.md' },
      {
        gate: false,
        blockLedger: true,
      },
    );
    expect(result).toContain('Refusing to write the timeline page directly');
  });

  it('refuses deleting and moving the ledger, not just appending', async () => {
    for (const tool of ['memory_forget', 'memory_move']) {
      const result = await dispatchMemoryMutation(
        okDispatch,
        tool,
        { slug: 'timeline' },
        {
          gate: false,
          blockLedger: true,
        },
      );
      expect(result, tool).toContain('Refusing to write the timeline page directly');
    }
  });

  it('still lets the memory agent write the ledger — it is the one that keeps it in order', async () => {
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'timeline', append: '- **2031-04-09** | The parcel arrived. [[orders/field-bag]]' },
      { gate: true, blockHotMemory: true },
    );
    expect(result).toContain('change id: c_');
  });

  it('leaves other pages alone', async () => {
    const result = await dispatchMemoryMutation(
      okDispatch,
      'memory_write',
      { slug: 'orders/field-bag' },
      {
        gate: false,
        blockLedger: true,
      },
    );
    expect(result).toContain('change id: c_');
  });

  it('journals what a slug-less op reported writing', async () => {
    // `memory_remember` takes text and no slug — memory chooses the pages. This module read the
    // destination off `args.slug` and so returned early on every one of them: no journal entry, no
    // change id, and a host digest that knew the agent had written without knowing where. On the
    // Vulpine review the page the agent had just created went unnamed and the same claims were
    // filed again onto a second page.
    const dispatch = async () =>
      JSON.stringify({
        change_id: 'chg_1',
        wrote: [
          { slug: 'shopping/vulpine-sofa', action: 'created' },
          { slug: 'timeline', action: 'appended' },
        ],
      });

    const result = await dispatchMemoryMutation(dispatch, 'memory_remember', { text: 'a review' }, { gate: false });

    expect(result).toContain('change id: c_');
    const changes = await readMemoryChanges();
    expect(changes.map((c) => c.slug)).toEqual(['shopping/vulpine-sofa', 'timeline']);
    // One id for the call: a `remember` filing two claims is one thing "undo that" has to mean.
    expect(new Set(changes.map((c) => c.id)).size).toBe(1);
  });

  it('journals the source page a retain receipt confirms, not its source_slug argument', async () => {
    const result = await dispatchMemoryMutation(
      async () =>
        JSON.stringify({
          outcome: 'preserved',
          preserved: true,
          source_slug: 'resources/daily-standup-rules',
          wrote: [{ slug: 'resources/daily-standup-rules', kind: 'source' }],
        }),
      'memory_retain',
      { text: 'A reference guide', source_slug: 'resources/daily-standup-rules' },
      { gate: false },
    );

    expect(result).toContain('change id: c_');
    expect((await readMemoryChanges()).map((change) => change.slug)).toEqual(['resources/daily-standup-rules']);
  });

  it('does not journal a retain result that did not preserve its source', async () => {
    const result = await dispatchMemoryMutation(
      async () => JSON.stringify({ outcome: 'held', preserved: false, wrote: [] }),
      'memory_retain',
      { text: 'A reference guide', source_slug: 'resources/daily-standup-rules' },
      { gate: false },
    );

    expect(result).not.toContain('change id');
    expect(await readMemoryChanges()).toHaveLength(0);
  });

  it('journals a move, which names its destination in `to`', async () => {
    const result = await dispatchMemoryMutation(
      async () => 'Moved',
      'memory_move',
      { from: 'wiki/old', to: 'wiki/new' },
      { gate: false },
    );

    expect(result).toContain('change id: c_');
    const changes = await readMemoryChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.slug).toBe('wiki/new');
    expect(changes[0]!.action).toBe('move');
  });

  it('journals the page an ingest made, never the file it came from', async () => {
    // `ingest` reports its page as a bare `slug`, not in `wrote` — and its own `path` argument is the
    // *file*. A generic "whichever argument names it" fallback reads that `path`, so the journal
    // would have claimed `/workspace/inbox/m-42/bill.pdf` was a page, and the digest's mission would
    // have offered a filesystem path as somewhere a claim already lives.
    const dispatch = async () =>
      JSON.stringify({ status: 'ok', change_id: 'chg_2', slug: 'receipts/2026-08-17-bill', rel_path: 'x.pdf' });

    const result = await dispatchMemoryMutation(
      dispatch,
      'memory_ingest',
      { path: '/workspace/inbox/m-42/bill.pdf', folder: 'receipts' },
      { gate: false },
    );

    expect(result).toContain('change id: c_');
    const changes = await readMemoryChanges();
    expect(changes.map((c) => c.slug)).toEqual(['receipts/2026-08-17-bill']);
  });

  it('says nothing extra when an op reported no page', async () => {
    // A `remember` that kept nothing is a normal outcome. Journalling a change for it, or appending
    // a change id to it, would claim a write that did not happen.
    const result = await dispatchMemoryMutation(
      async () => JSON.stringify({ outcome: 'noop', note: 'nothing worth keeping' }),
      'memory_remember',
      { text: 'chatter' },
      { gate: false },
    );

    expect(result).not.toContain('change id');
    expect(await readMemoryChanges()).toHaveLength(0);
  });
});

describe("skills are the agent's own to write", () => {
  let client: InMemorySessionClient;
  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
  });

  // There was a gate here that turned a new skill into an approval card. Only a background writer
  // ever set it, and that writer is gone — so the branch read like a policy and enforced nothing.
  // Creating is now plainly allowed, and journalled like any other write.
  it('creates without asking anyone', async () => {
    const result = await dispatchMemoryMutation(
      async () => 'Created skill',
      'manage_skill',
      { action: 'create', name: 'bank-review', description: 'x', body: 'y' },
      {},
    );

    expect(result).not.toMatch(/approval|pending/i);
    expect(result).toContain('change id: c_');
    const changes = await readMemoryChanges();
    expect(changes[0]).toMatchObject({ kind: 'skill', slug: 'bank-review', action: 'create', status: 'applied' });
    // No approval card was emitted.
    expect(client.outbound).toHaveLength(0);
  });

  // "That skill was a mistake, drop it" has to work as a sentence, so delete is journalled the same
  // way — with the prior body captured, which is what makes the removal inspectable afterwards.
  it('deletes on request, recording what was there', async () => {
    const result = await dispatchMemoryMutation(
      async () => 'Deleted skill',
      'manage_skill',
      { action: 'delete', name: 'bank-review' },
      {},
    );

    expect(result).toContain('change id: c_');
    expect((await readMemoryChanges())[0]).toMatchObject({ kind: 'skill', slug: 'bank-review', action: 'delete' });
    expect(client.outbound).toHaveLength(0);
  });

  it('leaves list and read alone — they change nothing', async () => {
    for (const action of ['list', 'read']) {
      const result = await dispatchMemoryMutation(async () => 'ok', 'manage_skill', { action, name: 'x' }, {});
      expect(result, action).toBe('ok');
      expect(await readMemoryChanges(), action).toHaveLength(0);
    }
  });
});

describe('recognising a memory write', () => {
  it('knows the names the bridge actually exposes', () => {
    for (const name of [
      'memory_write',
      'memory_remember',
      'memory_retain',
      'memory_forget',
      'memory_move',
      'memory_ingest',
    ]) {
      expect(isMutatingMemoryTool(name)).toBe(true);
    }
  });

  it('knows the mcp-qualified form too', () => {
    expect(isMutatingMemoryTool('mcp__memory__write')).toBe(true);
    expect(isMutatingMemoryTool('mcp__memory__remember')).toBe(true);
    expect(isMutatingMemoryTool('mcp__memory__retain')).toBe(true);
  });

  it('does not count reads', () => {
    for (const name of ['memory_recall', 'memory_read', 'memory_list', 'memory_timeline', 'Bash']) {
      expect(isMutatingMemoryTool(name)).toBe(false);
    }
  });

  it('takes the page from whichever argument names it', () => {
    expect(mutatedSlug({ slug: 'household/lease' })).toBe('household/lease');
    expect(mutatedSlug({ to: 'people/bran' })).toBe('people/bran');
    // An event with no slug goes to the ledger.
    expect(mutatedSlug({ event: { date: '2026-08-08', summary: 'Day trip' } })).toBe('timeline');
    // `remember` chooses the page itself, so there is nothing to record from the call.
    expect(mutatedSlug({ text: 'the rent went up' })).toBeNull();
    expect(mutatedSlug(undefined)).toBeNull();
  });

  it('maps a tool to the action the journal records', () => {
    expect(mutationAction('memory_forget')).toBe('delete');
    expect(mutationAction('mcp__memory__move')).toBe('move');
    expect(mutationAction('memory_write')).toBe('edit');
  });
});
