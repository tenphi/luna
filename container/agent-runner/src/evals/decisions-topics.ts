/** Invented development cases; no session, ledger or knowledge-base writes. */
import OpenAI from 'openai';
import { decideEpisode } from '../providers/openai/episodes/decide.js';
import { topicChoice } from '../providers/openai/episodes/decisions.js';
import { memoryChat } from '../providers/openai/episodes/memory-model.js';
import type { Episode } from '../providers/openai/episodes/ledger.js';
import type { ChatMessage } from '../providers/openai/types.js';
const model = process.env.OPENAI_MODEL || 'gpt-6-luna';
if (model !== 'gpt-6-luna') throw new Error('This live evaluation requires gpt-6-luna');
const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
const now = new Date('2026-10-09T12:00:00Z');
const common = { emoji: '💬', startedAt: now.toISOString(), lastActiveAt: now.toISOString(), slugs: [] };
const episodes: Episode[] = [
  {
    ...common,
    id: 'invented-soup',
    historyId: 'soup',
    title: 'Bean soup recipe',
    summary: 'The bean soup uses lentils and one teaspoon of salt.',
  },
  {
    ...common,
    id: 'invented-printer',
    historyId: 'printer',
    title: 'Zephyr printer paper jam',
    summary: 'A paper jam remains unresolved. The rear panel is open.',
  },
];
const history: ChatMessage[] = [
  { role: 'user', content: 'The Zephyr printer reports a paper jam.' },
  { role: 'assistant', content: 'Open the rear panel and inspect the paper path. Is there any paper left inside?' },
];
const cases = [
  ['Explain how volcanoes form.', 'new'],
  ['Объясни, как образуются вулканы.', 'new'],
  ['Leg uit hoe vulkanen ontstaan.', 'new'],
  ['Erkläre, wie Vulkane entstehen.', 'new'],
  ['And explain how volcanoes form.', 'new'],
  ['Давай обсудим устройство вулканов.', 'new'],
  ['There is no paper inside, but it still shows the same error.', 'continue'],
  ['Бумаги внутри нет, но он всё ещё показывает ту же ошибку.', 'continue'],
  ['Er zit geen papier meer in, maar dezelfde fout blijft staan.', 'continue'],
  ['Es ist kein Papier mehr drin, aber derselbe Fehler erscheint.', 'continue'],
  ['What should I try next to fix that paper jam?', 'continue'],
  ['Returning to the bean soup recipe, should I add lentils?', 'resume'],
  ['Вернёмся к рецепту фасолевого супа: сколько соли добавить?', 'resume'],
  ['Terug naar het recept voor bonensoep: hoeveel zout moet erin?', 'resume'],
  ['Zurück zum Bohnensuppenrezept: wie viel Salz brauche ich?', 'resume'],
  ['What is the warranty duration for a Zephyr QX-100 printer?', 'new'],
  ['A new garden irrigation plan needs two watering zones. Design one.', 'new'],
  ['Почему деревья сбрасывают листья осенью?', 'new'],
  ['The rear panel is open as you suggested. Where should I look now?', 'continue'],
  ['We discussed the bean soup earlier. Can I replace its lentils?', 'resume'],
] as const;
const receipts: {
  system: string;
  round: number;
  caseIndex: number;
  passed: boolean;
  action: string;
  uncertain: boolean;
  calls: number;
  latencyMs: number;
}[] = [];
for (let round = 0; round < 6; round++) {
  for (const [caseIndex, [userText, expected]] of cases.entries()) {
    for (const system of round === 0 ? ['decisions', 'model'] : ['decisions']) {
      let calls = 0;
      const started = performance.now();
      const decision = await decideEpisode({
        userText,
        episodes,
        history,
        now,
        decisions:
          system === 'decisions'
            ? async (input, choices) => {
                calls++;
                return topicChoice(client, model, input, choices);
              }
            : undefined,
        chat:
          system === 'model'
            ? async (messages, options) => {
                calls++;
                return memoryChat(messages, options);
              }
            : undefined,
      });
      receipts.push({
        system,
        round,
        caseIndex,
        passed:
          decision.action === expected &&
          !decision.uncertain &&
          (expected !== 'resume' || decision.episodeId === episodes[0]!.id),
        action: decision.action,
        uncertain: !!decision.uncertain,
        calls,
        latencyMs: Math.round(performance.now() - started),
      });
    }
  }
}
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const reports = Object.fromEntries(
  ['decisions', 'model'].map((system) => {
    const rows = receipts.filter((r) => r.system === system);
    return [
      system,
      {
        cases: rows.length,
        passed: rows.filter((r) => r.passed).length,
        modeled: rows.filter((r) => r.calls > 0).length,
        uncertain: rows.filter((r) => r.uncertain).length,
        p50Ms: quantile(
          rows.filter((r) => r.calls > 0).map((r) => r.latencyMs),
          0.5,
        ),
        p95Ms: quantile(
          rows.filter((r) => r.calls > 0).map((r) => r.latencyMs),
          0.95,
        ),
      },
    ];
  }),
);
console.log(
  JSON.stringify({
    kind: 'invented-topic-development-comparison',
    model,
    cases: cases.length,
    rounds: 6,
    reports,
    receipts,
  }),
);
if (receipts.some((r) => r.system === 'decisions' && !r.passed)) process.exitCode = 1;
