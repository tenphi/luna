import { beforeEach, describe, expect, it } from 'bun:test';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import {
  buildConversationPage,
  conversationSlug,
  drainConversationMirrors,
  mirrorEpisodeToMemory,
} from './mirror.js';
import { EPISODES_STATE_KEY, readEpisodes, type Episode } from './ledger.js';
import type { EpisodeSummary } from './summarize.js';

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_abcd1234',
    title: 'Blackwater Bay trip',
    emoji: '🏔️',
    historyId: 'hist-1',
    startedAt: '2026-07-27T10:00:00.000Z',
    lastActiveAt: '2026-07-27T11:00:00.000Z',
    summary: null,
    slugs: ['travel/blackwater-bay-plan'],
    ...overrides,
  };
}

const summary: EpisodeSummary = {
  title: 'Blackwater Bay trip',
  emoji: '🏔️',
  summary: 'On 27 July Ada asked me to plan five nights in Harbourtown; we settled on a bus from Eastport.',
  openThreads: ['book the bus'],
};

interface FakeBridge {
  hasConnectedServer(name: string): boolean;
  callRaw(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

/** Bridge that records memory ops and answers each one from a queue. */
function bridge(replies: string[] = [JSON.stringify({ outcome: 'ok' })], connected = true): FakeBridge {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const queue = [...replies];
  return {
    calls,
    hasConnectedServer: () => connected,
    callRaw: async (_server, tool, args) => {
      calls.push({ tool, args });
      return queue.shift() ?? JSON.stringify({ outcome: 'ok' });
    },
  };
}

describe('conversation mirror', () => {
  let client: InMemorySessionClient;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
  });

  it('slugs by start date and title', () => {
    expect(conversationSlug(episode())).toBe('conversations/2026-07-27-blackwater-bay-trip');
    expect(conversationSlug(episode({ title: '¿Qué? 🍝 pasta!' }))).toBe('conversations/2026-07-27-que-pasta');
    // A diacritic is dropped, not turned into a word break: `bla-vik-harbour` was the bug.
    expect(conversationSlug(episode({ title: 'Blåvik–Harbour train' }))).toBe('conversations/2026-07-27-blavik-harbour-train');
  });

  it('writes frontmatter, attributed prose, open threads, and touched pages', () => {
    const page = buildConversationPage(episode(), summary);

    expect(page).toContain('title: "Blackwater Bay trip"');
    expect(page).toContain('type: conversation');
    expect(page).toContain('tags: [conversation]');
    expect(page).toContain('date: 2026-07-27');
    expect(page).toContain('Ada asked me to plan five nights');
    expect(page).toContain('## Open threads\n- book the bus');
    expect(page).toContain('## Pages touched\n- [[travel/blackwater-bay-plan]]');
  });

  it('records the page slug and summary on the ledger entry', async () => {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify([episode(), episode({ id: 'ep_now' })]));
    const memory = bridge();

    const slug = await mirrorEpisodeToMemory(memory, episode(), summary);

    expect(slug).toBe('conversations/2026-07-27-blackwater-bay-trip');
    expect(memory.calls[0]?.tool).toBe('write');
    expect(memory.calls[0]?.args.slug).toBe(slug);
    expect(Object.keys(memory.calls[0]?.args ?? {}).sort()).toEqual(['content', 'slug']);
    const stored = (await readEpisodes())[0];
    expect(stored?.conversationPage).toBe(slug);
    expect(stored?.summary).toContain('Open: book the bus');
  });

  it('declares the conversations folder and repeats the write', async () => {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify([episode(), episode({ id: 'ep_now' })]));
    const memory = bridge([
      JSON.stringify({ outcome: 'requires_folder', requires_folder: { folder: 'conversations', nearest: [] } }),
      JSON.stringify({ outcome: 'ok' }),
      JSON.stringify({ outcome: 'ok' }),
    ]);

    const slug = await mirrorEpisodeToMemory(memory, episode(), summary);

    expect(memory.calls.map((c) => c.tool)).toEqual(['write', 'folder', 'write']);
    expect(memory.calls[1]?.args).toMatchObject({ path: 'conversations', role: 'source', remember: 'deny' });
    expect(slug).toBe('conversations/2026-07-27-blackwater-bay-trip');
    expect((await readEpisodes())[0]?.conversationPage).toBe(slug);
  });

  it('leaves the ledger alone when the write did not land', async () => {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify([episode(), episode({ id: 'ep_now' })]));
    const memory = bridge(['MCP tool error (write): memory is not answering']);

    expect(await mirrorEpisodeToMemory(memory, episode(), summary)).toBeNull();
    expect((await readEpisodes())[0]?.conversationPage).toBeUndefined();
  });

  it('suffixes rather than overwrites a page another episode owns', async () => {
    await client.setSessionState(
      EPISODES_STATE_KEY,
      JSON.stringify([
        episode({ id: 'ep_earlier', conversationPage: 'conversations/2026-07-27-blackwater-bay-trip' }),
        episode(),
      ]),
    );

    const slug = await mirrorEpisodeToMemory(bridge(), episode(), summary);

    expect(slug).toBe('conversations/2026-07-27-blackwater-bay-trip-1234');
  });

  it('skips the write when no memory server is connected', async () => {
    const memory = bridge(undefined, false);
    expect(await mirrorEpisodeToMemory(memory, episode(), summary)).toBeNull();
    expect(memory.calls).toHaveLength(0);
  });

  describe('catch-up pass', () => {
    it('mirrors a summarized episode that never got a page, threads intact', async () => {
      await client.setSessionState(
        EPISODES_STATE_KEY,
        JSON.stringify([
          episode({
            summary: 'On 27 July we settled on Harbourtown.\nOpen: book the bus; confirm the hotel',
            summarizedAt: '2026-07-27T12:00:00.000Z',
          }),
          episode({ id: 'ep_now' }),
        ]),
      );
      const memory = bridge();

      expect(await drainConversationMirrors(() => memory)).toBe(1);
      const page = String(memory.calls[0]?.args.content);
      expect(page).toContain('On 27 July we settled on Harbourtown.');
      expect(page).toContain('- book the bus');
      expect(page).toContain('- confirm the hotel');
      expect((await readEpisodes())[0]?.conversationPage).toBe('conversations/2026-07-27-blackwater-bay-trip');
    });

    it('skips episodes that already have a page, the live one, and unsummarized ones', async () => {
      await client.setSessionState(
        EPISODES_STATE_KEY,
        JSON.stringify([
          episode({ id: 'ep_done', conversationPage: 'conversations/2026-07-27-x', summarizedAt: 'x', summary: 's' }),
          episode({ id: 'ep_provisional', summary: 'user: something' }),
          episode({ id: 'ep_now', summary: 's', summarizedAt: 'x' }),
        ]),
      );
      const memory = bridge();

      expect(await drainConversationMirrors(() => memory)).toBe(0);
      expect(memory.calls).toHaveLength(0);
    });

    it('leaves a provisional summary unmirrored — it is the transcript, not a record', async () => {
      await client.setSessionState(
        EPISODES_STATE_KEY,
        JSON.stringify([
          episode({ summary: 'user: is the visa ready?\nassistant: not yet', summarizedAt: 'x' }),
          episode({ id: 'ep_now' }),
        ]),
      );
      const memory = bridge();

      expect(await drainConversationMirrors(() => memory)).toBe(0);
      expect(memory.calls).toHaveLength(0);
    });

    it('does not resolve a bridge when there is nothing to mirror', async () => {
      await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify([episode({ id: 'ep_now' })]));
      let resolved = 0;

      await drainConversationMirrors(() => {
        resolved++;
        return bridge();
      });

      expect(resolved).toBe(0);
    });
  });
});
