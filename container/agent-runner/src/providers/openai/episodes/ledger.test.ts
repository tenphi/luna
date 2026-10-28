import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { CHANGES_STATE_KEY, type MemoryChange } from '../tools/memory-mutations.js';
import { saveHistory, sessionExists, setSessionsDirForTests } from '../session-store.js';
import {
  appendEpisode,
  currentEpisode,
  EPISODES_STATE_KEY,
  MAX_EPISODES,
  readEpisodes,
  resumeEpisode,
  touchEpisode,
  touchedPagesSince,
  updateEpisode,
  writeEpisodes,
  type Episode,
} from './ledger.js';

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_1',
    title: 'Test',
    emoji: '💬',
    historyId: 'hist-1',
    startedAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
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
    at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('episode ledger', () => {
  let client: InMemorySessionClient;
  let sessionsDir: string;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episodes-'));
    setSessionsDirForTests(sessionsDir);
  });

  afterEach(() => {
    setSessionsDirForTests(null);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('returns an empty ledger for a fresh session', async () => {
    expect(await readEpisodes()).toEqual([]);
    expect(await currentEpisode()).toBeNull();
  });

  it('treats the tail entry as the current episode', async () => {
    await appendEpisode({ title: 'First', emoji: '1️⃣', historyId: 'h1' });
    const second = await appendEpisode({ title: 'Second', emoji: '2️⃣', historyId: 'h2' });

    const current = await currentEpisode();
    expect(current?.id).toBe(second.id);
    expect(current?.title).toBe('Second');
  });

  it('round-trips through session_state', async () => {
    const created = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'h1' });
    const raw = await client.getSessionState(EPISODES_STATE_KEY);
    expect(raw).toBeDefined();

    const [restored] = await readEpisodes();
    expect(restored).toEqual(created);
    expect(restored?.summary).toBeNull();
  });

  it('ignores a malformed or non-array row instead of throwing', async () => {
    await client.setSessionState(EPISODES_STATE_KEY, 'not json');
    expect(await readEpisodes()).toEqual([]);

    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify({ nope: true }));
    expect(await readEpisodes()).toEqual([]);

    await client.setSessionState(EPISODES_STATE_KEY, JSON.stringify([{ title: 'no id' }, episode()]));
    expect(await readEpisodes()).toHaveLength(1);
  });

  it('bounds the ledger to MAX_EPISODES, keeping the newest', async () => {
    const many = Array.from({ length: MAX_EPISODES + 5 }, (_, i) =>
      episode({ id: `ep_${i}`, historyId: `h${i}`, title: `T${i}` }),
    );
    await writeEpisodes(many);

    const stored = await readEpisodes();
    expect(stored).toHaveLength(MAX_EPISODES);
    expect(stored[0]?.id).toBe('ep_5');
    expect(stored[MAX_EPISODES - 1]?.id).toBe(`ep_${MAX_EPISODES + 4}`);
  });

  it('deletes history files for episodes that fall off the ledger', async () => {
    const many = Array.from({ length: MAX_EPISODES + 2 }, (_, i) =>
      episode({ id: `ep_${i}`, historyId: `h${i}` }),
    );
    for (const e of many) saveHistory(e.historyId, [{ role: 'user', content: 'hi' }]);
    expect(sessionExists('h0')).toBe(true);

    await writeEpisodes(many);

    // Trimmed entries lose their files; surviving entries keep theirs.
    expect(sessionExists('h0')).toBe(false);
    expect(sessionExists('h1')).toBe(false);
    expect(sessionExists('h2')).toBe(true);
    expect(sessionExists(`h${MAX_EPISODES + 1}`)).toBe(true);
  });

  it('keeps a history file that a surviving episode still points at', async () => {
    // Two entries sharing one file: trimming the older must not delete it.
    saveHistory('shared', [{ role: 'user', content: 'hi' }]);
    const many = [
      ...Array.from({ length: MAX_EPISODES }, (_, i) => episode({ id: `ep_${i}`, historyId: `h${i}` })),
      episode({ id: 'ep_keep', historyId: 'shared' }),
    ];
    many.unshift(episode({ id: 'ep_old', historyId: 'shared' }));

    await writeEpisodes(many);

    expect(sessionExists('shared')).toBe(true);
  });

  it('moves a resumed episode to the tail and starts a fresh active segment', async () => {
    const first = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'h1' });
    await appendEpisode({ title: 'Pasta', emoji: '🍝', historyId: 'h2' });
    const resumedAt = new Date('2026-07-02T12:00:00.000Z');

    const resumed = await resumeEpisode(first.id, resumedAt);

    expect(resumed?.id).toBe(first.id);
    expect((await currentEpisode())?.id).toBe(first.id);
    expect(resumed?.lastActiveAt).toBe(resumedAt.toISOString());
    expect(resumed?.activeSince).toBe(resumedAt.toISOString());
    // Resuming reorders, it never duplicates.
    expect(await readEpisodes()).toHaveLength(2);
  });

  it('gives a legacy active episode a boundary before refreshing its activity', async () => {
    const created = await appendEpisode({ title: 'Zephyr launch', emoji: '🚀', historyId: 'h1' });
    const previousActivity = '2026-07-02T10:00:00.000Z';
    const refreshedAt = new Date('2026-07-02T12:00:00.000Z');
    await updateEpisode(created.id, { activeSince: undefined, lastActiveAt: previousActivity });

    await touchEpisode(created.id, refreshedAt);

    const [stored] = await readEpisodes();
    expect(stored?.activeSince).toBe(previousActivity);
    expect(stored?.lastActiveAt).toBe(refreshedAt.toISOString());
  });

  it('returns null when resuming or updating an unknown id', async () => {
    expect(await resumeEpisode('ep_missing')).toBeNull();
    expect(await updateEpisode('ep_missing', { summary: 'x' })).toBeNull();
  });

  it('patches an episode in place', async () => {
    const created = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'h1' });

    await updateEpisode(created.id, { summary: 'We settled on Harbourtown.', conversationPage: 'conversations/2026-07-01-blackwater-bay' });

    const [stored] = await readEpisodes();
    expect(stored?.summary).toBe('We settled on Harbourtown.');
    expect(stored?.conversationPage).toBe('conversations/2026-07-01-blackwater-bay');
    expect(stored?.title).toBe('Blackwater Bay');
  });

  describe('touchedPagesSince', () => {
    it('returns pages written after the cutoff only', async () => {
      await client.setSessionState(
        CHANGES_STATE_KEY,
        JSON.stringify([
          change({ id: 'c_old', slug: 'people/old', at: '2026-07-01T09:00:00.000Z' }),
          change({ id: 'c_new', slug: 'people/new', at: '2026-07-01T13:00:00.000Z' }),
        ]),
      );

      const touched = await touchedPagesSince('2026-07-01T12:00:00.000Z');

      expect(touched).toEqual([{ slug: 'people/new', action: 'edit' }]);
    });

    it('keeps the latest action per slug', async () => {
      await client.setSessionState(
        CHANGES_STATE_KEY,
        JSON.stringify([
          change({ id: 'c_1', slug: 'travel/blackwater-bay', action: 'create', at: '2026-07-01T12:00:00.000Z' }),
          change({ id: 'c_2', slug: 'travel/blackwater-bay', action: 'edit', at: '2026-07-01T12:30:00.000Z' }),
        ]),
      );

      const touched = await touchedPagesSince('2026-07-01T00:00:00.000Z');

      expect(touched).toEqual([{ slug: 'travel/blackwater-bay', action: 'edit' }]);
    });

    it('skips reverted changes and skill writes', async () => {
      await client.setSessionState(
        CHANGES_STATE_KEY,
        JSON.stringify([
          change({ id: 'c_1', slug: 'people/gone', status: 'reverted' }),
          change({ id: 'c_2', slug: 'some-skill', kind: 'skill' }),
          change({ id: 'c_3', slug: 'people/kept' }),
        ]),
      );

      const touched = await touchedPagesSince('2026-07-01T00:00:00.000Z');

      expect(touched).toEqual([{ slug: 'people/kept', action: 'edit' }]);
    });

    it('caps the list, keeping the most recent writes', async () => {
      await client.setSessionState(
        CHANGES_STATE_KEY,
        JSON.stringify(
          Array.from({ length: 15 }, (_, i) =>
            change({ id: `c_${i}`, slug: `people/p${i}`, at: `2026-07-01T12:${String(i).padStart(2, '0')}:00.000Z` }),
          ),
        ),
      );

      const touched = await touchedPagesSince('2026-07-01T00:00:00.000Z', 3);

      expect(touched.map((t) => t.slug)).toEqual(['people/p12', 'people/p13', 'people/p14']);
    });

    it('returns nothing when the journal is empty or unreadable', async () => {
      expect(await touchedPagesSince('2026-07-01T00:00:00.000Z')).toEqual([]);

      await client.setSessionState(CHANGES_STATE_KEY, 'not json');
      expect(await touchedPagesSince('2026-07-01T00:00:00.000Z')).toEqual([]);
    });
  });
});
