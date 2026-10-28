import { beforeEach, describe, expect, it } from 'bun:test';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { CHANGES_STATE_KEY, type MemoryChange } from '../tools/memory-mutations.js';
import { buildRecentConversationsBlock } from './inject.js';
import { EPISODES_STATE_KEY, type Episode } from './ledger.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_1',
    title: 'Test topic',
    emoji: '💬',
    historyId: 'hist-1',
    startedAt: '2026-07-27T11:00:00.000Z',
    lastActiveAt: '2026-07-27T11:30:00.000Z',
    activeSince: '2026-07-27T11:00:00.000Z',
    summary: null,
    slugs: [],
    ...overrides,
  };
}

function change(overrides: Partial<MemoryChange> = {}): MemoryChange {
  return {
    id: 'c_1',
    action: 'edit',
    kind: 'page',
    slug: 'people/alice',
    before: null,
    status: 'applied',
    at: '2026-07-27T11:15:00.000Z',
    ...overrides,
  };
}

describe('recent conversations block', () => {
  let client: InMemorySessionClient;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
  });

  async function seed(episodes: Episode[], changes: MemoryChange[] = []): Promise<void> {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify(episodes));
    if (changes.length > 0) await client.setSessionState(CHANGES_STATE_KEY, JSON.stringify(changes));
  }

  it('says nothing on a session with only a fresh current episode', async () => {
    await seed([episode()]);
    expect(await buildRecentConversationsBlock({ now: NOW })).toBeNull();
  });

  it('says nothing on an empty ledger', async () => {
    expect(await buildRecentConversationsBlock({ now: NOW })).toBeNull();
  });

  it('lists the current episode with its touched pages', async () => {
    await seed(
      [episode({ id: 'ep_now', title: 'Blackwater Bay trip', emoji: '🏔️' })],
      [change({ slug: 'travel/blackwater-bay-plan' }), change({ id: 'c_2', action: 'create', slug: 'people/cyra-fern' })],
    );

    const block = await buildRecentConversationsBlock({ now: NOW });

    expect(block).toContain('<recent-conversations>');
    expect(block).toContain('- now · 🏔️ Blackwater Bay trip — pages touched: edit travel/blackwater-bay-plan, create people/cyra-fern');
    expect(block).not.toContain('ep_now');
  });

  it('lists closed episodes newest first with relative dates, summaries, and mirror pages', async () => {
    await seed([
      episode({
        id: 'ep_old',
        title: 'Pasta recipes',
        emoji: '🍝',
        lastActiveAt: '2026-07-21T18:00:00.000Z',
        summary: 'Anna asked for something quick; I suggested cacio e pepe.',
        conversationPage: 'conversations/2026-07-21-pasta-recipes',
      }),
      episode({ id: 'ep_mid', title: 'Context budget', emoji: '📊', lastActiveAt: '2026-07-26T09:00:00.000Z' }),
      episode({ id: 'ep_now', title: 'Blackwater Bay trip', emoji: '🏔️' }),
    ]);

    const lines = (await buildRecentConversationsBlock({ now: NOW }))!.split('\n');

    expect(lines[1]).toBe('- now · 🏔️ Blackwater Bay trip');
    expect(lines[2]).toBe('- ep_mid · 📊 Context budget — yesterday.');
    expect(lines[3]).toBe(
      '- ep_old · 🍝 Pasta recipes — Tuesday. Anna asked for something quick; I suggested cacio e pepe.' +
        ' (conversations/2026-07-21-pasta-recipes)',
    );
  });

  it('keeps at most injectCount entries, current included', async () => {
    await seed(
      ['ep_1', 'ep_2', 'ep_3', 'ep_4', 'ep_5'].map((id) => episode({ id, historyId: id })),
    );

    const lines = (await buildRecentConversationsBlock({ injectCount: 3, now: NOW }))!.split('\n');

    // open tag + 3 entries + close tag
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('now ·');
    expect(lines[2]).toContain('ep_4');
    expect(lines[3]).toContain('ep_3');
  });

  it('ignores changes from before the current episode started', async () => {
    await seed(
      [episode({ id: 'ep_now', startedAt: '2026-07-27T11:00:00.000Z' })],
      [change({ slug: 'people/stale', at: '2026-07-26T10:00:00.000Z' })],
    );

    expect(await buildRecentConversationsBlock({ now: NOW })).toBeNull();
  });

  it('ignores changes made by other topics before the current resumed segment', async () => {
    await seed(
      [
        episode({
          id: 'ep_now',
          title: 'Zephyr launch',
          startedAt: '2026-07-20T10:00:00.000Z',
          lastActiveAt: '2026-07-27T11:45:00.000Z',
          activeSince: '2026-07-27T11:45:00.000Z',
        }),
      ],
      [
        change({
          id: 'c_other',
          slug: 'finance/vulpine-mutual',
          at: '2026-07-27T11:30:00.000Z',
        }),
        change({
          id: 'c_current',
          slug: 'projects/zephyr-launch',
          at: '2026-07-27T11:50:00.000Z',
        }),
      ],
    );

    const block = await buildRecentConversationsBlock({ now: NOW });

    expect(block).toContain('projects/zephyr-launch');
    expect(block).not.toContain('finance/vulpine-mutual');
  });

  it('truncates a long summary', async () => {
    await seed([
      episode({ id: 'ep_old', summary: 'x'.repeat(500) }),
      episode({ id: 'ep_now' }),
    ]);

    const block = await buildRecentConversationsBlock({ now: NOW });

    expect(block).toContain('…');
    expect(block!.length).toBeLessThan(400);
  });
});
