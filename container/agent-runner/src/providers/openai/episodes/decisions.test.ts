import { resolveTopicsConfig } from './config.js';
import { describe, expect, it } from 'bun:test';
import OpenAI from 'openai';
import { parseTopicChoice, topicChoice } from './decisions.js';
import { decideEpisode } from './decide.js';
import type { Episode } from './ledger.js';
const choices = [
  { value: 'continue', description: 'Current' },
  { value: 'new', description: 'New' },
];
const answer = {
  type: 'choice',
  name: 'topic',
  choice: 'new',
  confidence: 0.8,
  probabilities: [
    { value: 'continue', probability: 0.1 },
    { value: 'new', probability: 0.9 },
  ],
};
const now = new Date('2026-10-09T12:00:00Z');
const episode: Episode = {
  id: 'invented-current',
  title: 'Zephyr printer repair',
  emoji: '🖨️',
  historyId: 'invented-history',
  startedAt: now.toISOString(),
  lastActiveAt: now.toISOString(),
  summary: null,
  slugs: [],
};
describe('Decisions topic routing', () => {
  it('defaults to Decisions and preserves explicit base-model selection', () => {
    expect(resolveTopicsConfig().classifier).toBe('decisions');
    expect(resolveTopicsConfig({ classifier: 'model' }).classifier).toBe('model');
  });
  it('rejects incomplete, unknown, duplicate, inconsistent and uncertain choices', () => {
    expect(parseTopicChoice({ answers: [answer] }, choices)).toBe('new');
    for (const a of [
      { ...answer, choice: 'unknown' },
      { ...answer, choice: 'continue' },
      { ...answer, confidence: 0.1 },
      {
        ...answer,
        probabilities: [
          { value: 'new', probability: 0.5 },
          { value: 'new', probability: 0.5 },
        ],
      },
      {
        ...answer,
        probabilities: [
          { value: 'new', probability: 0.51 },
          { value: 'continue', probability: 0.49 },
        ],
      },
    ])
      expect(parseTopicChoice({ answers: [a] }, choices)).toBeNull();
    expect(parseTopicChoice({ answers: [answer, answer] }, choices)).toBeNull();
  });
  it('uses the existing SDK auth and records zero-output input usage', async () => {
    let tokens = 0;
    const client = new OpenAI({
      apiKey: 'invented-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
      fetch: async (request, init) => {
        expect(String(request)).toBe('https://example.test/v1/decisions');
        const body = JSON.parse(init!.body as string);
        expect(body.questions[0].name).toBe('topic');
        expect(body.messages).toBeUndefined();
        return Response.json({ answers: [answer], usage: { input_tokens: 111 } });
      },
    });
    expect(
      await topicChoice(client, 'gpt-6-luna', 'invented message', choices, undefined, async (count) => {
        tokens = count;
      }),
    ).toBe('new');
    expect(tokens).toBe(111);
  });
  it('preserves free routing and maps only supplied earlier choices', async () => {
    let calls = 0;
    const earlier = { ...episode, id: 'invented-earlier', title: 'Bean soup recipe' };
    const decision = await decideEpisode({
      userText: 'Returning to the bean soup recipe, can I use less salt?',
      episodes: [earlier, episode],
      now,
      decisions: async (_input, options) => {
        calls++;
        expect(options.map((c) => c.value)).toEqual(['continue', 'new', 'uncertain', 'earlier_0']);
        return 'earlier_0';
      },
    });
    expect(decision).toMatchObject({ action: 'resume', episodeId: earlier.id, reason: 'decisions-resume' });
    await decideEpisode({
      userText: 'ok',
      episodes: [episode],
      now,
      decisions: async () => {
        calls++;
        return 'new';
      },
    });
    expect(calls).toBe(1);
  });
  it('retains history provisionally after provider or confidence failure', async () => {
    for (const decisions of [
      async () => null,
      async () => {
        throw new Error('invented failure');
      },
    ])
      expect(
        await decideEpisode({
          userText: 'Explain the Zephyr warranty conditions.',
          episodes: [episode],
          now,
          decisions,
        }),
      ).toMatchObject({ action: 'continue', uncertain: true });
  });
});
