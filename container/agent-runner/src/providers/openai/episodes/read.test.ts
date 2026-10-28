import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { saveHistory, setSessionsDirForTests } from '../session-store.js';
import type { ChatMessage } from '../types.js';
import { EPISODES_STATE_KEY, type Episode } from './ledger.js';
import { callReadTopic } from './read.js';
import { callEpisodeTool } from './tools.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_1',
    title: 'Pasta recipes',
    emoji: '🍝',
    historyId: 'hist-1',
    startedAt: '2026-07-27T11:00:00.000Z',
    lastActiveAt: '2026-07-27T11:30:00.000Z',
    summary: null,
    slugs: [],
    ...overrides,
  };
}

/** A user turn as the formatter stores it — envelope and all. */
function said(text: string, id = 1): ChatMessage {
  return { role: 'user', content: `<context timezone="Europe/Berlin" />\n<message id="${id}">${text}</message>` };
}

describe('read_topic', () => {
  let client: InMemorySessionClient;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
    setSessionsDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'read-topic-')));
  });

  async function seed(episodes: Episode[]): Promise<void> {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify(episodes));
  }

  it('lists every topic newest first when no id is given', async () => {
    await seed([
      episode({ id: 'ep_old', title: 'Pasta recipes', exchanges: 4 }),
      episode({ id: 'ep_now', title: 'Iceland trip', emoji: '🏔️' }),
    ]);

    const text = await callReadTopic({});

    expect(text.indexOf('ep_now')).toBeLessThan(text.indexOf('ep_old'));
    expect(text).toContain('🏔️ Iceland trip — current');
    expect(text).toContain('4 exchanges');
  });

  it('treats an empty id as a listing — models emit "" for optional params', async () => {
    await seed([episode({ id: 'ep_only' })]);
    expect(await callReadTopic({ episode_id: '   ' })).toContain('ep_only');
  });

  it('returns the header and the transcript of a parked topic', async () => {
    saveHistory('hist-old', [
      said('what should I cook?'),
      { role: 'assistant', content: 'Cacio e pepe.' },
      { role: 'user', content: '<memory>background facts</memory>' },
      said('how long does it take?', 2),
      { role: 'assistant', content: 'Twelve minutes.' },
    ]);
    await seed([
      episode({
        id: 'ep_old',
        historyId: 'hist-old',
        summary: 'Anna asked for something quick.',
        slugs: ['food/pasta'],
        conversationPage: 'conversations/2026-07-21-pasta-recipes',
        exchanges: 2,
      }),
      episode({ id: 'ep_now', historyId: 'hist-now' }),
    ]);

    const text = await callReadTopic({ episode_id: 'ep_old' });

    expect(text).toContain('🍝 Pasta recipes · ep_old');
    expect(text).toContain('2 exchanges');
    expect(text).toContain('Pages touched: food/pasta');
    expect(text).toContain('Anna asked for something quick.');
    expect(text).toContain('conversations/2026-07-21-pasta-recipes');
    expect(text).toContain('--- full transcript ---');
    expect(text).toContain('user: what should I cook?');
    expect(text).toContain('assistant: Twelve minutes.');
    // Injected blocks and the XML envelope never come back.
    expect(text).not.toContain('background facts');
    expect(text).not.toContain('<message');
  });

  it('clips to the tail and says so, honouring an explicit budget', async () => {
    const history = Array.from({ length: 40 }, (_, i) => said(`turn number ${i} ${'x'.repeat(60)}`, i));
    saveHistory('hist-long', history);
    await seed([episode({ id: 'ep_long', historyId: 'hist-long' }), episode({ id: 'ep_now' })]);

    const text = await callReadTopic({ episode_id: 'ep_long', chars: 500 });

    expect(text).toMatch(/--- last \d+ of \d+ characters \(raise "chars" for more\) ---/);
    expect(text).toContain('turn number 39');
    expect(text).not.toContain('turn number 0 ');
  });

  it('clamps an out-of-range budget instead of failing', async () => {
    saveHistory('hist-1', [said('hello')]);
    await seed([episode({ historyId: 'hist-1' }), episode({ id: 'ep_now' })]);

    expect(await callReadTopic({ episode_id: 'ep_1', chars: -5 })).toContain('user: hello');
    expect(await callReadTopic({ episode_id: 'ep_1', chars: 10_000_000 })).toContain('user: hello');
  });

  it('reads the current topic, but says its turns are already in context', async () => {
    saveHistory('hist-now', [said('still here')]);
    await seed([episode({ id: 'ep_now', historyId: 'hist-now' })]);

    const text = await callReadTopic({ episode_id: 'ep_now' });

    expect(text).toContain('already in your context');
    expect(text).toContain('user: still here');
  });

  it('explains a transcript the ledger has rolled past, pointing at the page', async () => {
    await seed([
      episode({
        id: 'ep_gone',
        historyId: 'hist-deleted',
        conversationPage: 'conversations/2026-07-01-old-thing',
      }),
      episode({ id: 'ep_now' }),
    ]);

    const text = await callReadTopic({ episode_id: 'ep_gone' });

    expect(text).toContain('no longer on disk');
    expect(text).toContain('conversations/2026-07-01-old-thing');
  });

  it('lists what exists when the id is unknown', async () => {
    await seed([episode({ id: 'ep_old' }), episode({ id: 'ep_now' })]);

    const text = await callReadTopic({ episode_id: 'ep_nope' });

    expect(text).toContain('No topic with id "ep_nope"');
    expect(text).toContain('ep_old');
  });

  it('never moves the ledger — reading is not resuming', async () => {
    saveHistory('hist-old', [said('about pasta')]);
    await seed([episode({ id: 'ep_old', historyId: 'hist-old' }), episode({ id: 'ep_now' })]);
    const before = await client.getSessionState(EPISODES_STATE_KEY);

    const { action } = await callEpisodeTool('read_topic', { episode_id: 'ep_old' });

    expect(action).toBeNull();
    expect(await client.getSessionState(EPISODES_STATE_KEY)).toBe(before);
  });

  it('reports an empty ledger rather than an error', async () => {
    expect(await callReadTopic({})).toBe('No topics yet.');
  });

  it('formats relative times against a fixed clock', async () => {
    const { renderTopicRead } = await import('./read.js');
    const text = renderTopicRead(episode({ exchanges: 3 }), [said('hi')], { now: NOW });
    expect(text).toContain('Started 1h ago, last active 30m ago · 3 exchanges');
  });
});
