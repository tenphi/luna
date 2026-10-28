import { describe, expect, it } from 'bun:test';

import { decideEpisode, freeGate, type MemoryChatFn } from './decide.js';
import type { Episode } from './ledger.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const ONE_MINUTE_AGO = new Date(NOW.getTime() - 60_000).toISOString();
const ONE_HOUR_AGO = new Date(NOW.getTime() - 3_600_000).toISOString();

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep_current',
    title: 'Blackwater Bay trip planning',
    emoji: '🏔️',
    historyId: 'hist-current',
    startedAt: ONE_HOUR_AGO,
    lastActiveAt: ONE_HOUR_AGO,
    summary: null,
    slugs: [],
    ...overrides,
  };
}

/** Free gate with the message arriving inside the follow-up window. */
function gate(text: string, lastActiveAt = ONE_MINUTE_AGO) {
  return freeGate(text, { lastActiveAt, now: NOW });
}

describe('freeGate', () => {
  it('classifies substantive pronoun-led messages instead of assuming their topic', () => {
    for (const text of [
      'it should be five nights, not four',
      "that's too expensive",
      'they said the ferry is cancelled',
    ]) {
      expect(gate(text).kind).toBe('ask');
    }
    expect(gate('this one instead').kind).toBe('continue');
  });

  it('classifies connective messages because the opener cannot decide dependence', () => {
    for (const text of ['and the flights?', 'also add a rental car', 'plus a hotel in Harbourtown', 'so what next']) {
      expect(gate(text).kind).toBe('ask');
    }
  });

  it('continues only on a reference that lacks its own subject', () => {
    for (const text of ['what about that one?', 'what else', 'how come', 'this one instead'])
      expect(gate(text).kind).toBe('continue');
    for (const text of ['what about the flights?', 'how about Tuesday']) expect(gate(text).kind).toBe('ask');
  });

  it('continues on acknowledgements and object-less imperatives', () => {
    for (const text of ['ok', 'yes please', 'no, the other one', 'thanks!', 'do it', 'go ahead', 'try again', 'explain']) {
      expect(gate(text).kind).toBe('continue');
    }
  });

  it('continues on a Cyrillic acknowledgement, which the English tables cannot read', () => {
    for (const text of ['да', 'ок', 'давай', 'продолжай', 'спасибо!', 'попробуй снова']) {
      expect(gate(text).kind).toBe('continue');
    }
  });

  it('asks once a follow-up cue has gone stale — "ok" hours later opens a conversation', () => {
    for (const text of ['ok', 'do it', 'that one instead', 'thanks!']) {
      expect(gate(text, ONE_HOUR_AGO)).toEqual({ kind: 'ask', reason: 'stale-follow-up' });
    }
  });

  it('asks on weak cues, which read as follow-ups only in context', () => {
    for (const text of [
      // Fresh questions that merely open with `why`.
      "why don't push notifications show up on the lock screen?",
      'why not',
      // Existential `there`, not anaphoric.
      'There is a storm warning for the coast. Could it affect the ferry?',
      // A bare fragment: the same rule fires on every language the tables
      // cannot read, so it is no longer worth a free continue.
      'Harbourtown, 5 nights',
      'Кто изобрёл телефон?',
      'что это за птица?',
      'Погода в Осло?',
      'City aquarium',
      'Mic check 🙂',
      'llama3 8b?',
    ]) {
      expect(gate(text).kind).toBe('ask');
    }
  });

  it('asks on a bare link — the link is the subject', () => {
    expect(gate('https://example.com/articles/12345')).toEqual({ kind: 'ask', reason: 'link-only' });
  });

  it('sees past a greeting to the actual request', () => {
    expect(gate('Hey! What is the weather tomorrow?')).toEqual({ kind: 'ask', reason: 'fresh-subject' });
    expect(gate('good morning — book a table for Friday').kind).toBe('ask');
  });

  it('gives a greeted message no follow-up credit — "hey there!" is not an anaphor', () => {
    // Stripping the greeting leaves "there!" sitting where the opener tables
    // read it, which filed every hello under whatever came before it — at gaps
    // of up to a day in the transcripts this was found in.
    for (const text of ['Hey there!', 'Hey, there! Quick one — what is the capital of Peru?']) {
      expect(gate(text, ONE_HOUR_AGO).kind).toBe('ask');
    }
    // Inside the tiny no-signal window it is still the same breath.
    expect(gate('Hey there!')).toEqual({ kind: 'continue', reason: 'within-window-reaction' });
  });

  it('treats a bare greeting as no signal at all', () => {
    expect(gate('hey')).toEqual({ kind: 'continue', reason: 'greeting-only' });
    expect(gate('Hi!', ONE_HOUR_AGO)).toEqual({ kind: 'continue', reason: 'greeting-only' });
  });

  it('asks the classifier for a fresh imperative even seconds later', () => {
    for (const text of [
      "let's plan the Blackwater Bay trip",
      'research the best time to visit Harbourtown',
      'remind me to renew the visa on 29 July',
      'what is the weather in Blackwater Bay',
      'can you check my calendar for tomorrow',
      'i need a summary of the contract',
    ]) {
      expect(gate(text, ONE_MINUTE_AGO)).toEqual({ kind: 'ask', reason: 'fresh-subject' });
    }
  });

  it('asks the classifier when the message points back at an earlier conversation', () => {
    for (const text of [
      'We discussed the 55 cm cabin bag earlier. Find exact measures.',
      'back to the Blackwater Bay trip',
      "let's get back to that refactor",
      'you mentioned a cheaper grinder',
      'continue with the visa paperwork',
      'yesterday we picked the 5-night option — book it',
    ]) {
      // Even inside the continue window: a resume is phrased this way.
      expect(gate(text, ONE_MINUTE_AGO)).toEqual({ kind: 'ask', reason: 'back-reference' });
    }
  });

  it('asks the classifier about an attachment even when the caption depends on context', () => {
    const bland = 'thoughts on this layout please';
    expect(freeGate(bland, { lastActiveAt: ONE_MINUTE_AGO, now: NOW })).toEqual({
      kind: 'ask',
      reason: 'no-signal',
    });
    expect(freeGate(bland, { lastActiveAt: ONE_MINUTE_AGO, now: NOW, attachmentCount: 1 })).toEqual({
      kind: 'ask',
      reason: 'attachment',
    });
  });

  it('asks about an attachment even under a follow-up-shaped caption', () => {
    // "that's wrong" over a *fresh* photo is the same failure as a caption-less
    // one wearing a word of cover: the file is the subject, and the caption says
    // nothing about what it is. One classifier call decides; its own anaphora
    // rule still sends a genuine "here's the screenshot of that error" back to
    // `continue`.
    expect(freeGate("that's wrong", { lastActiveAt: ONE_MINUTE_AGO, now: NOW, attachmentCount: 1 })).toEqual({
      kind: 'ask',
      reason: 'attachment',
    });
    // Without an attachment it still needs the classifier to judge dependence.
    expect(freeGate("that's wrong", { lastActiveAt: ONE_MINUTE_AGO, now: NOW }).kind).toBe('ask');
  });

  it('never waves through a file sent with no caption at all', () => {
    // The regression: `!text → continue` fired before the attachment check, so
    // a bill sent with nothing typed was filed under the previous topic.
    expect(freeGate('', { lastActiveAt: ONE_MINUTE_AGO, now: NOW, attachmentCount: 1 })).toEqual({
      kind: 'ask',
      reason: 'attachment-only',
    });
    // A genuinely empty message with nothing attached still continues.
    expect(freeGate('', { lastActiveAt: ONE_MINUTE_AGO, now: NOW })).toEqual({
      kind: 'continue',
      reason: 'empty-message',
    });
  });

  it('lets an explicit switch cue outrank an attachment', () => {
    expect(
      freeGate('new topic — look at this', { lastActiveAt: ONE_MINUTE_AGO, now: NOW, attachmentCount: 1 }),
    ).toEqual({ kind: 'switch', reason: 'explicit-cue' });
  });

  it('checks the attachment before the length cutoff', () => {
    // A long caption over a file used to report `long-message`; the reason is
    // load-bearing only in logs, but the ordering is what makes the classifier
    // see the file as the subject rather than the prose.
    const long = 'x'.repeat(300);
    expect(freeGate(long, { lastActiveAt: ONE_MINUTE_AGO, now: NOW, attachmentCount: 1 }).reason).toBe('attachment');
    expect(freeGate(long, { lastActiveAt: ONE_MINUTE_AGO, now: NOW }).reason).toBe('long-message');
  });

  it('switches on an explicit cue, even when it opens like an acknowledgement', () => {
    for (const text of [
      'new topic: dinner tonight',
      "let's switch to something else",
      'no, forget that — dinner tonight',
      'unrelated question about the invoice',
    ]) {
      expect(gate(text).kind).toBe('switch');
    }
  });

  it('classifies a complete statement even inside the short window', () => {
    const noSignal = 'the ferry from Eastport leaves at 22:00 on weekdays only';
    expect(gate(noSignal, ONE_MINUTE_AGO)).toEqual({ kind: 'ask', reason: 'no-signal' });
    expect(gate(noSignal, ONE_HOUR_AGO)).toEqual({ kind: 'ask', reason: 'no-signal' });
  });

  it('asks about a long message regardless of the window', () => {
    const long = `${'context about a whole new subject '.repeat(10)}`;
    expect(gate(long, ONE_MINUTE_AGO).kind).toBe('ask');
  });

  it('honours a custom continue window', () => {
    const reaction = '👍';
    const tenMinutesAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(freeGate(reaction, { lastActiveAt: tenMinutesAgo, now: NOW, continueWindowMinutes: 30 }).kind).toBe(
      'continue',
    );
    expect(gate(reaction, tenMinutesAgo).kind).toBe('ask');
  });

  it('honours a custom follow-up window', () => {
    expect(freeGate('ok', { lastActiveAt: ONE_HOUR_AGO, now: NOW, followUpWindowMinutes: 120 }).kind).toBe(
      'continue',
    );
  });

  it('asks about complete new requests despite connective or acknowledgement openers', () => {
    for (const text of [
      'And explain how volcanoes form.',
      'Yes, explain how volcanoes form.',
      'Давай обсудим устройство вулканов.',
      'Да, расскажи, почему извергаются вулканы.',
      'Что вызывает извержения вулканов?',
    ]) {
      expect(gate(text, ONE_MINUTE_AGO).kind).toBe('ask');
    }
  });

  it('continues on an empty message rather than switching', () => {
    expect(gate('   ').kind).toBe('continue');
  });

  /**
   * Sentence shapes the gate used to wave through into an unrelated topic,
   * paired with a gap of the kind they really arrive after. Every one of them
   * has to reach the classifier — it is the only thing here that can read what
   * a message is actually about.
   *
   * Shapes, not transcripts: the gate matches on openers and word counts, so a
   * paraphrase exercises the same branch as the message that exposed it.
   */
  const SWALLOWED = [
    // Greeting stripped to a bare anaphor.
    { text: 'Hey there!', idle: 171 },
    { text: 'Hey, there! Quick one — what is the capital of Peru?', idle: 1147 },
    { text: 'Hello! 👋', idle: 864 },
    // `^why` on a question that carries its own subject.
    { text: "Why don't push notifications show up on the lock screen?", idle: 2 },
    { text: 'why did the second season finale get pushed back by a whole year', idle: 255 },
    { text: 'Why would that cost extra?', idle: 12 },
    // Existential `there`, not anaphoric.
    { text: 'There is a storm warning for the coast. Could it affect the ferry?', idle: 40 },
    // Short fragments with no English opener to read.
    { text: 'Mic check 🙂', idle: 23 },
    { text: 'One more check 🙂', idle: 113 },
    { text: 'City aquarium', idle: 61 },
    { text: 'Iceland trip', idle: 33 },
    { text: 'Estimate for launch', idle: 9 },
    { text: 'llama3 8b?', idle: 7 },
    { text: 'Our new houseplant', idle: 148 },
    { text: 'the wider angle', idle: 244 },
    { text: 'Save this invoice', idle: 319 },
    // …in any language, including inside the continue window.
    { text: 'Кто изобрёл телефон?', idle: 1.4 },
    { text: 'что это за птица?', idle: 0.7 },
    { text: 'Погода в Осло?', idle: 5 },
    { text: 'Поезд отменили сегодня', idle: 4 },
    // A bare link is the subject, not a continuation.
    { text: 'https://example.com/articles/12345', idle: 2 },
  ];

  it.each(SWALLOWED)('never free-continues $text', ({ text, idle }) => {
    const lastActiveAt = new Date(NOW.getTime() - idle * 60_000).toISOString();
    expect(freeGate(text, { lastActiveAt, now: NOW }).kind).not.toBe('continue');
  });
});

describe('decideEpisode', () => {
  const never: MemoryChatFn = async () => {
    throw new Error('classifier must not be called');
  };

  it('opens the first episode without a model call', async () => {
    const decision = await decideEpisode({
      userText: "let's plan the Blackwater Bay trip",
      episodes: [],
      now: NOW,
      chat: never,
    });

    expect(decision.action).toBe('new');
    expect(decision.reason).toBe('first-episode');
    expect(decision.title).toBe('Plan the Blackwater Bay trip');
    expect(decision.emoji).toBe('💬');
  });

  it('settles bare follow-ups without a model call', async () => {
    const decision = await decideEpisode({
      userText: 'what about that one?',
      episodes: [episode({ lastActiveAt: ONE_MINUTE_AGO })],
      now: NOW,
      chat: never,
    });

    expect(decision).toEqual({ action: 'continue', reason: 'follow-up-language' });
  });

  it('applies the dependence test to a complete request inside the time window', async () => {
    for (const text of ['And explain how volcanoes form.', 'Давай обсудим устройство вулканов.']) {
      let calls = 0;
      const decision = await decideEpisode({
        userText: text,
        episodes: [episode({ lastActiveAt: ONE_MINUTE_AGO })],
        now: NOW,
        chat: async () => {
          calls++;
          return '{"decision":"new","title":"Volcano formation","emoji":"🌋"}';
        },
      });
      expect(calls).toBe(1);
      expect(decision).toMatchObject({ action: 'new', title: 'Volcano formation', reason: 'classifier-new' });
    }
  });

  it('tells the classifier how many files came with the message', async () => {
    let prompt = '';
    const decision = await decideEpisode({
      userText: 'Is it a good answer? Can you suggest improvements?',
      episodes: [episode()],
      now: NOW,
      attachments: { count: 1, imageCount: 1, documentCount: 0, gist: '', titleHint: '' },
      chat: async (messages) => {
        prompt = String(messages[1]?.content ?? '');
        return JSON.stringify({ decision: 'new', title: 'Reply to Grant', emoji: '✉️' });
      },
    });

    expect(prompt).toContain('New message (1 file attached):');
    expect(decision.action).toBe('new');
  });

  it('shows the classifier what the attachments actually say', async () => {
    let prompt = '';
    const decision = await decideEpisode({
      userText: '',
      episodes: [episode()],
      now: NOW,
      attachments: {
        count: 1,
        imageCount: 0,
        documentCount: 1,
        gist: '123456789.pdf: Blackwater Bay Water annual drinking-water bill, €42.00 due, invoice INV-0001',
        titleHint: '',
      },
      chat: async (messages) => {
        prompt = String(messages[1]?.content ?? '');
        return JSON.stringify({ decision: 'new', title: 'Blackwater Bay water bill', emoji: '💧' });
      },
    });

    // The gist rides in the user message, never the system prompt — it is
    // content of a file anyone who can DM the bot controls.
    expect(String(prompt)).toContain('Attached:');
    expect(String(prompt)).toContain('Blackwater Bay Water annual drinking-water bill');
    expect(decision.action).toBe('new');
    expect(decision.title).toBe('Blackwater Bay water bill');
  });

  it('names a caption-less attachment from its filename when the model gives no title', async () => {
    const decision = await decideEpisode({
      userText: '',
      episodes: [episode()],
      now: NOW,
      attachments: {
        count: 1,
        imageCount: 0,
        documentCount: 1,
        gist: 'blackwater-water-invoice.pdf: annual bill',
        titleHint: 'Blackwater Bay Water invoice',
      },
      chat: async () => JSON.stringify({ decision: 'new' }),
    });

    expect(decision.action).toBe('new');
    expect(decision.title).toBe('Blackwater Bay Water invoice');
    // Never the XML envelope, which is what the old topicText fallback produced.
    expect(decision.title).not.toContain('<');
  });

  it('names an explicit-cue switch from the message itself', async () => {
    const decision = await decideEpisode({
      userText: 'new topic: dinner reservations tonight',
      episodes: [episode()],
      now: NOW,
      chat: never,
    });

    expect(decision.action).toBe('new');
    expect(decision.reason).toBe('explicit-cue');
    expect(decision.title).toBe('Dinner reservations tonight');
  });

  it('takes title and emoji from the classifier on a new topic', async () => {
    const chat: MemoryChatFn = async () =>
      '{"decision":"new","title":"Dinner reservations","emoji":"🍽️ tonight"}';

    const decision = await decideEpisode({
      userText: 'book a table for two at 8pm',
      episodes: [episode()],
      now: NOW,
      chat,
    });

    expect(decision).toEqual({
      action: 'new',
      title: 'Dinner reservations',
      emoji: '🍽️',
      reason: 'classifier-new',
    });
  });

  it('resumes an earlier episode by id, keeping its stored title', async () => {
    const older = episode({ id: 'ep_pasta', title: 'Pasta recipes', emoji: '🍝', historyId: 'hist-pasta' });
    const chat: MemoryChatFn = async () => '{"decision":"resume","episodeId":"ep_pasta","title":"whatever"}';

    const decision = await decideEpisode({
      userText: 'can we get back to the pasta thing',
      episodes: [older, episode()],
      now: NOW,
      chat,
    });

    expect(decision).toEqual({
      action: 'resume',
      episodeId: 'ep_pasta',
      title: 'Pasta recipes',
      emoji: '🍝',
      reason: 'classifier-resume',
    });
  });

  it('sends the ledger and the current topic to the classifier', async () => {
    const older = episode({ id: 'ep_pasta', title: 'Pasta recipes', emoji: '🍝' });
    let prompt = '';
    const chat: MemoryChatFn = async (messages) => {
      prompt = messages.map((m) => m.content).join('\n');
      return '{"decision":"continue"}';
    };

    await decideEpisode({
      userText: 'research ferry options from Eastport',
      episodes: [older, episode({ summary: 'We settled on Harbourtown.' })],
      history: [
        { role: 'user', content: 'how many nights in Harbourtown?' },
        { role: 'assistant', content: 'Five works well.' },
      ],
      now: NOW,
      chat,
    });

    expect(prompt).toContain('Blackwater Bay trip planning');
    expect(prompt).toContain('We settled on Harbourtown.');
    expect(prompt).toContain('how many nights in Harbourtown?');
    expect(prompt).toContain('ep_pasta 🍝 Pasta recipes');
    expect(prompt).toContain('research ferry options from Eastport');
  });

  it('asks the classifier for an English title', async () => {
    // The title lands on a stored episode and in the `conversations/<date>-…`
    // slug, which keeps only [a-z0-9] — a Russian title slugs to nothing.
    let system = '';
    const chat: MemoryChatFn = async (messages) => {
      system = messages[0]?.content ?? '';
      return '{"decision":"continue"}';
    };

    await decideEpisode({
      userText: 'посмотри варианты паромов из Истпорта',
      episodes: [episode()],
      now: NOW,
      chat,
    });

    expect(system).toContain('"title" is always in ENGLISH');
  });

  describe('replies', () => {
    const pasta = episode({ id: 'ep_pasta', title: 'Pasta recipes', emoji: '🍝', historyId: 'hist-pasta' });

    it('resumes the quoted message’s topic without a model call', async () => {
      // The reported case: a reply carrying no topic signal of its own ("in
      // russian?") used to read as a follow-up to whatever was open.
      const decision = await decideEpisode({
        userText: 'in russian?',
        episodes: [pasta, episode()],
        now: NOW,
        reply: { text: 'Boil the pasta one minute short of the packet time.', episodeId: 'ep_pasta' },
        chat: never,
      });

      expect(decision).toEqual({
        action: 'resume',
        episodeId: 'ep_pasta',
        title: 'Pasta recipes',
        emoji: '🍝',
        reason: 'reply-to-earlier-topic',
      });
    });

    it('continues when the quote came from the current topic', async () => {
      const decision = await decideEpisode({
        userText: 'in russian?',
        episodes: [pasta, episode()],
        now: NOW,
        reply: { text: 'Five nights in Harbourtown works well.', episodeId: 'ep_current' },
        chat: never,
      });

      expect(decision).toEqual({ action: 'continue', reason: 'reply-to-current-topic' });
    });

    it('lets an explicit switch cue outrank the reply', async () => {
      const decision = await decideEpisode({
        userText: 'new topic: dinner tonight',
        episodes: [pasta, episode()],
        now: NOW,
        reply: { text: 'Boil the pasta one minute short of the packet time.', episodeId: 'ep_pasta' },
        chat: never,
      });

      expect(decision.action).toBe('new');
      expect(decision.reason).toBe('explicit-cue');
    });

    it('asks the classifier when the quote matched no episode', async () => {
      let prompt = '';
      const decision = await decideEpisode({
        userText: 'in russian?',
        episodes: [
          episode({ id: 'ep_pasta', title: 'Pasta recipes', emoji: '🍝', summary: 'Carbonara without cream.' }),
          episode(),
        ],
        now: NOW,
        // Placement failed (compacted away, or older than the search window),
        // so the words go to the classifier instead of being dropped.
        reply: { text: 'Boil the pasta one minute short of the packet time.', episodeId: null },
        chat: async (messages) => {
          prompt = String(messages[1]?.content ?? '');
          return '{"decision":"resume","episodeId":"ep_pasta"}';
        },
      });

      expect(prompt).toContain('Replying to this earlier message:');
      expect(prompt).toContain('Boil the pasta one minute short');
      // Titles alone can't place a quote, so earlier topics carry a summary here.
      expect(prompt).toContain('Carbonara without cream.');
      expect(decision.action).toBe('resume');
      expect(decision.episodeId).toBe('ep_pasta');
    });

    it('resumes a stale episode id no longer in the ledger via the classifier', async () => {
      const decision = await decideEpisode({
        userText: 'in russian?',
        episodes: [episode()],
        now: NOW,
        reply: { text: 'Boil the pasta one minute short of the packet time.', episodeId: 'ep_trimmed' },
        chat: async () => '{"decision":"continue"}',
      });

      expect(decision).toEqual({ action: 'continue', reason: 'classifier-continue' });
    });

    it('keeps earlier topics summary-free when no quote needs placing', async () => {
      let prompt = '';
      await decideEpisode({
        userText: 'research ferry options from Eastport',
        episodes: [episode({ id: 'ep_pasta', title: 'Pasta recipes', summary: 'Carbonara without cream.' }), episode()],
        now: NOW,
        chat: async (messages) => {
          prompt = String(messages[1]?.content ?? '');
          return '{"decision":"continue"}';
        },
      });

      expect(prompt).toContain('ep_pasta');
      expect(prompt).not.toContain('Carbonara without cream.');
    });
  });

  describe('degradation', () => {
    const cases: Array<[string, Awaited<ReturnType<MemoryChatFn>> | 'throw', string]> = [
      ['an unreachable endpoint', null, 'classifier-unusable'],
      ['malformed JSON', 'decision: probably new?', 'classifier-unusable'],
      ['a truncated object', '{"decision":"new"', 'classifier-unusable'],
      ['an unknown decision', '{"decision":"maybe"}', 'classifier-unknown-decision'],
      ['a resume for an unknown id', '{"decision":"resume","episodeId":"ep_gone"}', 'classifier-resume-unknown-id'],
      ['a resume for the current episode', '{"decision":"resume","episodeId":"ep_current"}', 'classifier-resume-current'],
      ['a thrown classifier error', 'throw', 'classifier-failed'],
    ];

    for (const [label, reply, reason] of cases) {
      it(`retains context on ${label} and marks uncertain placement`, async () => {
        const chat: MemoryChatFn = async () => {
          if (reply === 'throw') throw new Error('synthetic endpoint failure');
          return reply;
        };
        const decision = await decideEpisode({
          userText: 'research ferry options from Eastport',
          episodes: [episode()],
          now: NOW,
          chat,
        });

        expect(decision).toEqual({
          action: 'continue',
          reason,
          ...(reason === 'classifier-resume-current' ? {} : { uncertain: true }),
        });
      });
    }
  });
});
