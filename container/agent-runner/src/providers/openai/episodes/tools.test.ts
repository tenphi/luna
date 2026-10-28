import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { saveHistory, sessionExists, setSessionsDirForTests } from '../session-store.js';
import { EPISODES_STATE_KEY, readEpisodes, type Episode } from './ledger.js';
import { callEpisodeTool, episodeToolSchemas, isEpisodeTool } from './tools.js';
import { applyTopicAction } from './turn.js';

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_1',
    title: 'Test topic',
    emoji: '💬',
    historyId: 'hist-1',
    startedAt: '2026-07-27T11:00:00.000Z',
    lastActiveAt: '2026-07-27T11:30:00.000Z',
    summary: null,
    slugs: [],
    ...overrides,
  };
}

describe('topic escape-hatch tools', () => {
  let client: InMemorySessionClient;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
    setSessionsDirForTests(fs.mkdtempSync(path.join(os.tmpdir(), 'topic-tools-')));
  });

  async function seed(episodes: Episode[]): Promise<void> {
    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify(episodes));
  }

  it('exposes every tool under its documented name', () => {
    expect(episodeToolSchemas().map((t) => t.function.name)).toEqual([
      'start_new_topic',
      'resume_topic',
      'read_topic',
    ]);
    expect(isEpisodeTool('start_new_topic')).toBe(true);
    expect(isEpisodeTool('resume_topic')).toBe(true);
    expect(isEpisodeTool('read_topic')).toBe(true);
    expect(isEpisodeTool('put_memory_page')).toBe(false);
  });

  it('records a new-topic intent with a sanitized title and emoji', async () => {
    const { text, action } = await callEpisodeTool('start_new_topic', {
      title: '  "Blackwater Bay trip"  ',
      emoji: 'not an emoji',
    });

    expect(action).toEqual({ kind: 'new', title: 'Blackwater Bay trip', emoji: '💬' });
    expect(text).toContain('Blackwater Bay trip');
  });

  it('rejects a new topic with no usable title', async () => {
    expect(await callEpisodeTool('start_new_topic', {})).toEqual({
      text: 'Error: title is required.',
      action: null,
    });
  });

  it('returns the resumed topic’s summary so the agent can bridge in the same turn', async () => {
    await seed([
      episode({
        id: 'ep_old',
        title: 'Pasta recipes',
        summary: 'Anna asked for something quick.',
        conversationPage: 'conversations/2026-07-21-pasta-recipes',
      }),
      episode({ id: 'ep_now', historyId: 'hist-now' }),
    ]);

    const { text, action } = await callEpisodeTool('resume_topic', { episode_id: 'ep_old' });

    expect(action).toEqual({ kind: 'resume', episodeId: 'ep_old' });
    expect(text).toContain('Anna asked for something quick.');
    expect(text).toContain('conversations/2026-07-21-pasta-recipes');
  });

  it('refuses unknown and already-current topics, listing what exists', async () => {
    await seed([episode({ id: 'ep_old' }), episode({ id: 'ep_now', title: 'Now' })]);

    const missing = await callEpisodeTool('resume_topic', { episode_id: 'ep_nope' });
    expect(missing.action).toBeNull();
    expect(missing.text).toContain('ep_old');

    const current = await callEpisodeTool('resume_topic', { episode_id: 'ep_now' });
    expect(current.action).toBeNull();
    expect(current.text).toContain('already the current topic');
  });

  it('applying a new-topic intent archives the current episode and opens a named one', async () => {
    await seed([episode({ id: 'ep_now', historyId: 'hist-now' })]);
    const history = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
    ];

    const switched = await applyTopicAction({ kind: 'new', title: 'Blackwater Bay trip', emoji: '🏔️' }, history);

    expect(switched?.history).toEqual([]);
    expect(switched?.current.title).toBe('Blackwater Bay trip');
    expect(sessionExists(switched!.historyId)).toBe(false);

    const episodes = await readEpisodes();
    expect(episodes.map((e) => e.id)).toEqual(['ep_now', switched!.current.id]);
    expect(episodes[0]?.summary).toContain('first');
    expect(episodes[0]?.exchanges).toBe(1);
  });

  it('applying a resume intent loads that episode’s history and makes it current', async () => {
    saveHistory('hist-old', [{ role: 'user', content: 'about pasta' }]);
    await seed([
      episode({ id: 'ep_old', historyId: 'hist-old' }),
      episode({ id: 'ep_now', historyId: 'hist-now' }),
    ]);

    const switched = await applyTopicAction({ kind: 'resume', episodeId: 'ep_old' }, [
      { role: 'user', content: 'current turn' },
    ]);

    expect(switched?.historyId).toBe('hist-old');
    expect(switched?.history).toEqual([{ role: 'user', content: 'about pasta' }]);
    expect((await readEpisodes()).map((e) => e.id)).toEqual(['ep_now', 'ep_old']);
  });

  it('degrades to no switch when the resume target left the ledger', async () => {
    await seed([episode({ id: 'ep_now', historyId: 'hist-now' })]);

    expect(await applyTopicAction({ kind: 'resume', episodeId: 'ep_gone' }, [])).toBeNull();
  });
});
