import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { InMemorySessionClient, setSessionClient } from '../../../session/client.js';
import { CHANGES_STATE_KEY, type MemoryChange } from '../tools/memory-mutations.js';
import { loadHistory, saveHistory, setSessionsDirForTests } from '../session-store.js';
import type { ChatMessage } from '../types.js';
import type { MemoryChatFn } from './decide.js';
import { appendEpisode, readEpisodes, updateEpisode } from './ledger.js';
import {
  applyTopicAction,
  closeCurrentEpisode,
  isTrivialEpisode,
  needsSummary,
  resolveEpisodeForTurn,
} from './turn.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function exchange(userText: string, reply: string): ChatMessage[] {
  return [
    { role: 'user', content: userText },
    { role: 'assistant', content: reply },
  ];
}

const never: MemoryChatFn = async () => {
  throw new Error('classifier must not be called');
};

let sessionsDir: string;

/** A history file left behind by an older install, last written long ago. */
function writeStaleSession(id: string, messages: ChatMessage[], updatedAt: string): void {
  fs.writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({ messages, updated_at: updatedAt }),
  );
}

describe('resolveEpisodeForTurn', () => {
  let client: InMemorySessionClient;

  beforeEach(() => {
    client = new InMemorySessionClient();
    setSessionClient(client);
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-turn-'));
    setSessionsDirForTests(sessionsDir);
  });

  afterEach(() => {
    setSessionsDirForTests(null);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('opens the first episode on a brand-new session', async () => {
    const turn = await resolveEpisodeForTurn({
      userText: "let's plan the Blackwater Bay trip",
      continuation: null,
      history: [],
      now: NOW,
      chat: never,
    });

    expect(turn.history).toEqual([]);
    expect(turn.current.title).toBe('Plan the Blackwater Bay trip');
    expect(turn.historyId).toBe(turn.current.historyId);
    expect(turn.event?.action).toBe('new');
    // Nothing to signal a switch *from*, so the divider stays quiet.
    expect(turn.event?.first).toBe(true);
    expect(await readEpisodes()).toHaveLength(1);
  });

  it('adopts an existing pre-episode history instead of orphaning it', async () => {
    const history = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('legacy', history);

    const turn = await resolveEpisodeForTurn({
      userText: 'what about that one?',
      continuation: 'legacy',
      history,
      now: NOW,
      chat: never,
    });

    expect(turn.historyId).toBe('legacy');
    expect(turn.history).toEqual(history);
    expect(turn.event).toBeUndefined();
    const [adopted] = await readEpisodes();
    expect(adopted?.title).toBe('Earlier conversation');
  });

  it('adopts with the history file\'s own last-active time, so a stale session can still switch', async () => {
    const history = exchange('what happened to the old lighthouse?', 'Long story.');
    const yesterday = new Date(NOW.getTime() - 20 * 3_600_000).toISOString();
    writeStaleSession('legacy', history, yesterday);

    const turn = await resolveEpisodeForTurn({
      userText: 'the ferry from Eastport leaves at 22:00 on weekdays only',
      continuation: 'legacy',
      history,
      now: NOW,
      // Stamping lastActiveAt=now used to make the free gate answer
      // "within-window" and never get here.
      chat: async () => JSON.stringify({ decision: 'new', title: 'Eastport ferry', emoji: '⛴️' }),
    });

    const episodes = await readEpisodes();
    expect(episodes[0]?.lastActiveAt).toBe(yesterday);
    expect(turn.event?.action).toBe('new');
    expect(turn.history).toEqual([]);
  });

  it('continues on the same history file and refreshes lastActiveAt', async () => {
    const history = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('hist-1', history);
    const opened = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-1' });

    const turn = await resolveEpisodeForTurn({
      userText: 'what about that one?',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: never,
    });

    expect(turn.historyId).toBe('hist-1');
    expect(turn.history).toEqual(history);
    expect(turn.event).toBeUndefined();
    expect(turn.current.lastActiveAt >= opened.lastActiveAt).toBe(true);
  });

  it('leaves the clock alone for a bare greeting, so the real request keeps its gap', async () => {
    const history = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('hist-1', history);
    const opened = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-1' });
    // Pretend the topic went quiet an hour ago.
    const anHourAgo = new Date(NOW.getTime() - 3_600_000).toISOString();
    await updateEpisode(opened.id, { lastActiveAt: anHourAgo });

    await resolveEpisodeForTurn({
      userText: 'Hey!',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: never,
    });

    // Stamping this would tell the next message the topic was active seconds
    // ago, and whatever the user actually wanted would look mid-thread.
    expect((await readEpisodes())[0]?.lastActiveAt).toBe(anHourAgo);
  });

  it('marks a classifier failure as provisional while preserving follow-up timing', async () => {
    const history = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('hist-1', history);
    const opened = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-1' });
    const anHourAgo = new Date(NOW.getTime() - 3_600_000).toISOString();
    await updateEpisode(opened.id, { lastActiveAt: anHourAgo });

    const turn = await resolveEpisodeForTurn({
      userText: 'Давай обсудим устройство вулканов.',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: async () => null,
    });

    expect(turn.uncertain).toBe(true);
    expect(turn.historyId).toBe('hist-1');
    expect((await readEpisodes())[0]?.lastActiveAt).not.toBe(anHourAgo);
  });

  it('closes the old episode and starts an empty history on a switch', async () => {
    const history = [
      ...exchange('how many nights in Harbourtown?', 'Five works well.'),
      ...exchange('and the ferry?', 'It runs at 22:00.'),
    ];
    saveHistory('hist-1', history);
    const first = await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-1' });

    const turn = await resolveEpisodeForTurn({
      userText: 'new topic: dinner reservations tonight',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: never,
    });

    expect(turn.history).toEqual([]);
    expect(turn.historyId).not.toBe('hist-1');
    expect(turn.event).toMatchObject({ action: 'new', first: false, closedTrivial: false });

    const episodes = await readEpisodes();
    expect(episodes).toHaveLength(2);
    const closed = episodes[0]!;
    expect(closed.id).toBe(first.id);
    expect(closed.exchanges).toBe(2);
    // A provisional summary lands synchronously so the block right after a
    // switch is never blank.
    expect(closed.summary).toContain('Harbourtown');
    expect(needsSummary(closed)).toBe(true);
    // The old history file survives so a resume can load the real tail.
    expect(loadHistory('hist-1')).toEqual(history);
  });

  it('marks a one-shot close as trivial so the divider stays quiet', async () => {
    const history = exchange("what's the weather?", 'Sunny, 24°.');
    saveHistory('hist-1', history);
    await appendEpisode({ title: 'Weather', emoji: '☀️', historyId: 'hist-1' });

    const turn = await resolveEpisodeForTurn({
      userText: 'new topic: dinner tonight',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: never,
    });

    expect(turn.event?.closedTrivial).toBe(true);
    const closed = (await readEpisodes())[0]!;
    expect(isTrivialEpisode(closed)).toBe(true);
    expect(needsSummary(closed)).toBe(false);
  });

  it('counts a memory write as substance even in a one-shot episode', async () => {
    const history = exchange('remember that Anna prefers tea', 'Noted.');
    saveHistory('hist-1', history);
    const opened = await appendEpisode({ title: 'Anna', emoji: '🫖', historyId: 'hist-1' });
    const change: MemoryChange = {
      id: 'c_1',
      action: 'edit',
      kind: 'page',
      slug: 'people/anna',
      before: null,
      status: 'applied',
      at: new Date(new Date(opened.startedAt).getTime() + 1000).toISOString(),
    };
    await client.setSessionState(CHANGES_STATE_KEY, JSON.stringify([change]));

    const turn = await resolveEpisodeForTurn({
      userText: 'new topic: dinner tonight',
      continuation: 'hist-1',
      history,
      now: NOW,
      chat: never,
    });

    expect(turn.event?.closedTrivial).toBe(false);
    expect((await readEpisodes())[0]?.slugs).toEqual(['people/anna']);
  });

  it('resumes an earlier episode by loading its own history file', async () => {
    const pastaHistory = exchange('какое тесто для карбонары?', 'Spaghetti works.');
    saveHistory('hist-pasta', pastaHistory);
    const pasta = await appendEpisode({ title: 'Pasta recipes', emoji: '🍝', historyId: 'hist-pasta' });
    const currentHistory = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('hist-current', currentHistory);
    await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-current' });

    const chat: MemoryChatFn = async () => `{"decision":"resume","episodeId":"${pasta.id}"}`;
    const turn = await resolveEpisodeForTurn({
      userText: 'can we go back to the pasta thing',
      continuation: 'hist-current',
      history: currentHistory,
      now: NOW,
      chat,
    });

    expect(turn.historyId).toBe('hist-pasta');
    expect(turn.history).toEqual(pastaHistory);
    expect(turn.event).toMatchObject({
      action: 'resumed',
      episodeId: pasta.id,
      title: 'Pasta recipes',
      emoji: '🍝',
      lastActiveAt: pasta.lastActiveAt,
      closedTrivial: false,
    });

    // Resuming reorders the ledger and closes the topic we left.
    const episodes = await readEpisodes();
    expect(episodes.map((e) => e.historyId)).toEqual(['hist-current', 'hist-pasta']);
    expect(episodes[0]?.summary).toContain('Harbourtown');
  });

  it('keeps prior topic pages but excludes writes from other topics after a resume', async () => {
    const oldHistory = [
      ...exchange('What remains for the Zephyr launch?', 'The release checklist.'),
      ...exchange('Draft the rollout order.', 'I will start with the pilot group.'),
    ];
    saveHistory('hist-zephyr', oldHistory);
    const zephyr = await appendEpisode({ title: 'Zephyr launch', emoji: '🚀', historyId: 'hist-zephyr' });
    await updateEpisode(zephyr.id, {
      activeSince: undefined,
      lastActiveAt: '2026-07-20T10:00:00.000Z',
      slugs: ['projects/zephyr-launch'],
    });

    const currentHistory = exchange('Compare the Vulpine Mutual plans.', 'I will compare their coverage.');
    saveHistory('hist-current', currentHistory);
    await appendEpisode({ title: 'Insurance comparison', emoji: '🛡️', historyId: 'hist-current' });

    const switched = await applyTopicAction(
      { kind: 'resume', episodeId: zephyr.id },
      currentHistory,
    );
    const activeSince = switched!.current.activeSince!;
    await client.setSessionState(
      CHANGES_STATE_KEY,
      JSON.stringify([
        {
          id: 'c_unrelated',
          action: 'edit',
          kind: 'page',
          slug: 'finance/vulpine-mutual',
          before: null,
          status: 'applied',
          at: new Date(new Date(activeSince).getTime() - 1000).toISOString(),
        } satisfies MemoryChange,
        {
          id: 'c_relevant',
          action: 'edit',
          kind: 'page',
          slug: 'projects/zephyr-launch-checklist',
          before: null,
          status: 'applied',
          at: new Date(new Date(activeSince).getTime() + 1000).toISOString(),
        } satisfies MemoryChange,
      ]),
    );

    const { closed } = await closeCurrentEpisode([
      ...oldHistory,
      ...exchange('Add the pilot checklist.', 'Added it to the launch notes.'),
    ]);

    expect(closed?.slugs).toEqual([
      'projects/zephyr-launch',
      'projects/zephyr-launch-checklist',
    ]);
    expect(closed?.activeSince).toBeUndefined();
  });

  describe('replies', () => {
    /** Two topics, the older one holding the message the tests quote. */
    async function twoTopics(): Promise<{ pastaId: string }> {
      saveHistory('hist-pasta', [
        { role: 'user', content: '<message sender="Ada">how do I cook carbonara?</message>' },
        {
          role: 'assistant',
          content: '**Boil the pasta** one minute short of the packet time, then finish it in the pan.',
        },
      ]);
      const pasta = await appendEpisode({ title: 'Pasta recipes', emoji: '🍝', historyId: 'hist-pasta' });
      saveHistory('hist-current', exchange('how many nights in Harbourtown?', 'Five works well.'));
      await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-current' });
      return { pastaId: pasta.id };
    }

    it('resumes the topic holding the quoted message, with no classifier call', async () => {
      const { pastaId } = await twoTopics();

      const turn = await resolveEpisodeForTurn({
        userText: 'in russian?',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        // What Telegram hands back: the rendered text, markdown stripped.
        replyTo: { id: '4021', text: 'Boil the pasta one minute short of the packet time, then finish it in the pan.' },
        chat: never,
      });

      expect(turn.historyId).toBe('hist-pasta');
      expect(turn.event).toMatchObject({ action: 'resumed', episodeId: pastaId, title: 'Pasta recipes' });
    });

    it('matches a quote of the user’s own message through the XML envelope', async () => {
      const { pastaId } = await twoTopics();

      const turn = await resolveEpisodeForTurn({
        userText: 'still wondering about this',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        replyTo: { id: '4020', text: 'how do I cook carbonara?', sender: 'Ada' },
        chat: never,
      });

      expect(turn.historyId).toBe('hist-pasta');
      expect(turn.event?.episodeId).toBe(pastaId);
    });

    it('ignores a quoted_message block an earlier reply left in another history', async () => {
      const { pastaId } = await twoTopics();
      // A previous reply to the same message was filed here, so this history
      // *mentions* the quote without the message ever being said in it.
      saveHistory('hist-current', [
        {
          role: 'user',
          content:
            '<message sender="Ada">\n  <quoted_message from="Luna">Boil the pasta one minute short of the packet time, then finish it in the pan.</quoted_message>\n  in russian?</message>',
        },
        { role: 'assistant', content: 'Отвари макароны на минуту меньше.' },
      ]);

      const turn = await resolveEpisodeForTurn({
        userText: 'in russian?',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        replyTo: { id: '4021', text: 'Boil the pasta one minute short of the packet time, then finish it in the pan.' },
        chat: never,
      });

      expect(turn.historyId).toBe('hist-pasta');
      expect(turn.event?.episodeId).toBe(pastaId);
    });

    it('stays put when the quote came from the current topic', async () => {
      await twoTopics();

      const turn = await resolveEpisodeForTurn({
        userText: 'in russian?',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        replyTo: { id: '4030', text: 'Five works well.' },
        chat: never,
      });

      expect(turn.historyId).toBe('hist-current');
      expect(turn.event).toBeUndefined();
    });

    it('ignores a quote too short to identify anything', async () => {
      await twoTopics();

      // "thanks!" appears in every episode; matching it would resume at random.
      const turn = await resolveEpisodeForTurn({
        userText: 'ok',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        replyTo: { id: '4031', text: 'Thanks!' },
        chat: never,
      });

      expect(turn.historyId).toBe('hist-current');
    });

    it('hands an unplaceable quote to the classifier instead of dropping it', async () => {
      await twoTopics();
      let prompt = '';

      const turn = await resolveEpisodeForTurn({
        userText: 'in russian?',
        continuation: 'hist-current',
        history: loadHistory('hist-current') ?? [],
        now: NOW,
        replyTo: { id: '4032', text: 'Something said in a topic that has since been trimmed away.' },
        chat: async (messages) => {
          prompt = String(messages[1]?.content ?? '');
          return '{"decision":"continue"}';
        },
      });

      expect(prompt).toContain('Replying to this earlier message:');
      expect(turn.historyId).toBe('hist-current');
    });
  });
});

describe('closeCurrentEpisode', () => {
  let sessionsDir: string;

  beforeEach(() => {
    setSessionClient(new InMemorySessionClient());
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-clear-'));
    setSessionsDirForTests(sessionsDir);
  });

  afterEach(() => {
    setSessionsDirForTests(null);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('archives the current episode and opens an unnamed one', async () => {
    const history = exchange('how many nights in Harbourtown?', 'Five works well.');
    saveHistory('hist-1', history);
    await appendEpisode({ title: 'Blackwater Bay', emoji: '🏔️', historyId: 'hist-1' });

    const { closed, opened } = await closeCurrentEpisode(history);

    expect(closed?.summary).toContain('Harbourtown');
    expect(opened.title).toBe('New topic');
    expect((await readEpisodes()).map((e) => e.title)).toEqual(['Blackwater Bay', 'New topic']);
  });

  it('names the episode /clear left behind from the next message', async () => {
    await closeCurrentEpisode([]);

    const turn = await resolveEpisodeForTurn({
      userText: 'research ferry options from Eastport',
      continuation: null,
      history: [],
      now: NOW,
      chat: never,
    });

    expect(turn.current.title).toBe('Research ferry options from Eastport');
    expect(turn.event).toBeUndefined();
    expect(await readEpisodes()).toHaveLength(1);
  });

  it('opens an episode even when there was nothing to close', async () => {
    const { closed, opened } = await closeCurrentEpisode([]);

    expect(closed).toBeNull();
    expect(opened.title).toBe('New topic');
  });
});
