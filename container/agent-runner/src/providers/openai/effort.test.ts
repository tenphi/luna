import { expect, test } from 'bun:test';
import { chooseEffort, effortInput } from './effort.js';
import type { ChatMessage } from './types.js';
import type OpenAI from 'openai';

const history: ChatMessage[] = [{ role: 'user', content: '<message>Compare these options.</message>' }];
const answer = (choice: string, confidence = 0.9) => ({
  answers: [
    {
      type: 'choice',
      name: 'effort',
      choice,
      confidence,
      probabilities: ['low', 'medium', 'high'].map((value) => ({ value, probability: value === choice ? 0.8 : 0.1 })),
    },
  ],
});

test('effort context excludes system instructions, tool results and injected service data', () => {
  const input = effortInput([
    { role: 'system', content: 'SYSTEM CANARY' },
    { role: 'assistant', content: 'A previous answer' },
    { role: 'tool', tool_call_id: 'x', content: 'TOOL CANARY' },
    {
      role: 'user',
      content:
        '<memory>MEMORY CANARY</memory>\n<calendar-agenda>CALENDAR CANARY</calendar-agenda>\n<message>Latest question</message>',
    },
  ]);
  expect(input).toContain('Latest question');
  expect(input).toContain('A previous answer');
  expect(input).not.toContain('CANARY');
  expect(effortInput([{ role: 'user', content: 'x'.repeat(10000) }]).length).toBeLessThan(4200);
});

test('valid bounded Decisions choice controls effort with one-second deadline', async () => {
  let request: any;
  const post = (async (_url: string, options: any) => {
    request = options;
    return answer('high');
  }) as OpenAI['post'];
  expect(await chooseEffort({ post }, 'gpt-6-luna', history)).toBe('high');
  expect(request.timeout).toBe(1000);
  expect(request.maxRetries).toBe(0);
  expect(request.body.questions[0].name).toBe('effort');
  expect(request.body.questions[0].choices.map((choice: any) => choice.value)).toEqual(['low', 'medium', 'high']);
});

test('unavailable, uncertain, malformed or unsupported Decisions preserve thinking', async () => {
  expect(await chooseEffort({}, 'gpt-6-luna', history)).toBe('medium');
  for (const response of [answer('low', 0.1), answer('none'), { answers: [] }]) {
    const post = (async () => response) as OpenAI['post'];
    expect(await chooseEffort({ post }, 'gpt-6-luna', history)).toBe('medium');
  }
  const post = (async () => {
    throw new Error('unavailable');
  }) as OpenAI['post'];
  expect(await chooseEffort({ post }, 'gpt-6-luna', history)).toBe('medium');
  expect(await chooseEffort({ post }, 'other-model', history)).toBe('medium');
});

test('reports whether medium came from a decision or the conservative fallback', async () => {
  const selections: { effort: string; source: string }[] = [];
  await chooseEffort(
    { post: (async () => answer('medium')) as OpenAI['post'] },
    'gpt-6-luna',
    history,
    undefined,
    undefined,
    (value) => selections.push(value),
  );
  await chooseEffort(
    {
      post: (async () => {
        throw new Error('synthetic timeout');
      }) as OpenAI['post'],
    },
    'gpt-6-luna',
    history,
    undefined,
    undefined,
    (value) => selections.push(value),
  );
  expect(selections.map(({ effort, source }) => ({ effort, source }))).toEqual([
    { effort: 'medium', source: 'decisions' },
    { effort: 'medium', source: 'fallback' },
  ]);
});
