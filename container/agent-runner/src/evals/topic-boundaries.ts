import { writeEvalResults, type EvalResult } from './public-context.js';
import OpenAI from 'openai';
import { topicChoice } from '../providers/openai/episodes/decisions.js';
/** Live topic-dependence check with invented conversations and no state writes. */
import { decideEpisode } from '../providers/openai/episodes/decide.js';
import type { Episode } from '../providers/openai/episodes/ledger.js';
import type { ChatMessage } from '../providers/openai/types.js';

const model = process.env.OPENAI_MODEL || 'gpt-6-luna';
const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
const decisions =
  process.env.LUNA_TOPIC_CLASSIFIER === 'model'
    ? undefined
    : (input: string, choices: import('../providers/openai/episodes/decisions.js').TopicChoice[]) =>
        topicChoice(client, model, input, choices);

const now = new Date('2026-09-25T12:00:00.000Z');
const recent = new Date(now.getTime() - 60_000).toISOString();
const earlier: Episode = {
  id: 'ep_recipe',
  title: 'Bean soup recipe',
  emoji: '🥣',
  historyId: 'hist-recipe',
  startedAt: recent,
  lastActiveAt: recent,
  summary: 'The user chose a mild bean soup.',
  slugs: [],
};
const current: Episode = {
  id: 'ep_trip',
  title: 'Blackwater Bay trip planning',
  emoji: '🏔️',
  historyId: 'hist-trip',
  startedAt: recent,
  lastActiveAt: recent,
  summary: 'The user chose five nights in Harbourtown.',
  slugs: [],
};
const history: ChatMessage[] = [
  { role: 'user', content: 'How many nights in Harbourtown?' },
  { role: 'assistant', content: 'Five nights would allow time for the bay and the old town.' },
];

const cases = [
  { name: 'English connective opens a new subject', text: 'And explain how volcanoes form.', want: 'new' },
  { name: 'Russian directive opens a new subject', text: 'Давай обсудим устройство вулканов.', want: 'new' },
  { name: 'Russian question inside the time window', text: 'Что вызывает извержения вулканов?', want: 'new' },
  {
    name: 'Trip follow-up stays with the trip',
    text: 'Also add a rental car to the Harbourtown itinerary.',
    want: 'continue',
  },
  {
    name: 'Explicit earlier-topic resume',
    text: 'Going back to the bean soup recipe, should I add lentils?',
    want: 'resume',
  },
  { name: 'Dutch question opens a new subject', text: 'Leg uit hoe vulkanen ontstaan.', want: 'new' },
  { name: 'Bare reference stays with the trip', text: 'What about that one?', want: 'continue' },
] as const;

let failures = 0;
const results: EvalResult[] = [];
for (const check of cases) {
  const started = performance.now();
  const decision = await decideEpisode({
    userText: check.text,
    episodes: [earlier, current],
    history,
    now,
    decisions,
  });
  const passed = decision.action === check.want && !decision.uncertain;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${check.name}: ${decision.action} (${decision.reason})`);
  results.push({
    name: check.name,
    passed,
    problems: passed ? [] : [decision.reason],
    elapsedMs: Math.round(performance.now() - started),
    toolCalls: 0,
  });
  if (!passed) failures++;
}

const reply = await decideEpisode({
  userText: 'Use less salt?',
  episodes: [earlier, current],
  history,
  now,
  reply: { text: 'Use a teaspoon of salt for the bean soup.', episodeId: earlier.id },
});
const replyPassed = reply.action === 'resume' && reply.episodeId === earlier.id;
console.log(`${replyPassed ? 'PASS' : 'FAIL'} Explicit reply resumes older topic: ${reply.action} (${reply.reason})`);
results.push({
  name: 'Explicit reply resumes older topic',
  passed: replyPassed,
  problems: replyPassed ? [] : [reply.reason],
  elapsedMs: 0,
  toolCalls: 0,
});
if (!replyPassed) failures++;
writeEvalResults('topic-boundaries', results);

console.log(`${cases.length + 1 - failures}/${cases.length + 1} topic-boundary scenarios passed`);
if (failures) process.exitCode = 1;
