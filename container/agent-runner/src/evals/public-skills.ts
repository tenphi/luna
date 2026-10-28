/** Live skill routing and evidence checks. Every source and tool result is invented. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublicEvalProvider, publicContext, writeEvalResults, type EvalResult } from './public-context.js';
import type { OpenAITool } from '../providers/openai/tools/builtin.js';
import type { ProviderEvent } from '../providers/types.js';
import { setSessionsDirForTests } from '../providers/openai/session-store.js';
import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';

type Call = { name: string; args: Record<string, unknown> };
const schema = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): OpenAITool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const text = { type: 'string' };
const TOOLS = [
  schema('Skill', 'Load the repository skill instructions before following its workflow.', { name: text }, ['name']),
  schema('web_search', 'Find sources relevant to a question.', { query: text }, ['query']),
  schema('web_read', 'Open an exact source URL and return its complete text.', { url: text }, ['url']),
  schema('memory_read', 'Read an existing canonical knowledge page.', { slug: text }, ['slug']),
  schema(
    'memory_update',
    'Replace a canonical page after reading it; returns a write receipt.',
    { slug: text, content: text },
    ['slug', 'content'],
  ),
  schema(
    'report_totals',
    'Read normalized report totals and exclusions for a month.',
    { period: { type: 'string', description: 'Reporting month in YYYY-MM format', pattern: '^\\d{4}-\\d{2}$' } },
    ['period'],
  ),
];
const originalProfile = '# Ada Marlow\n\nBo Winters is a colleague (user supplied).\n';
class World {
  calls: Call[] = [];
  profile = originalProfile;
  constructor(readonly kind: string) {
    if (kind === 'ambiguous') this.profile = '# Ada Marlow\nWorks with Silverhaven Studio (user supplied).';
  }
  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    this.calls.push({ name, args });
    if (name === 'Skill') return JSON.stringify(publicContext().skill(String(args.name)) ?? { error: 'Unknown skill' });
    if (name === 'web_search')
      return JSON.stringify({
        results:
          this.kind === 'product'
            ? [
                'https://maker.example.test/orion-300-a',
                'https://lab.example.test/orion-300-a',
                'https://owners.example.test/orion-300-a',
              ]
            : this.kind === 'shop'
              ? [
                  'https://store.example.test/about',
                  'https://registry.example.test/store',
                  'https://reviews.example.test/store',
                ]
              : ['https://studio.example.test/ada', 'https://music.example.test/ada'],
      });
    if (name === 'web_read') {
      const sources: Record<string, string> = {
        'https://store.example.test':
          'Silverhaven Supply storefront. Company information: https://store.example.test/about. Independent identity lookup: https://registry.example.test/store. Claims global delivery; dispatch country is not stated.',
        'https://maker.example.test/orion-300-a':
          'Orion Fan 300 revision A. Rated power 55 W. Maker claims quiet operation. Warranty two years. No acoustic measurement supplied.',
        'https://lab.example.test/orion-300-a':
          'Independent hands-on test of Orion Fan 300 revision A. One unit measured 62 dB at one metre on maximum. Strong airflow, noisy on maximum. No long-term durability data. Tested 2031-04-01. No affiliate links.',
        'https://owners.example.test/orion-300-a':
          'Three owners mention high-speed noise. One reports a loose grille; unverified reports, not failure-rate data. Posted 2031-04-02.',
        'https://store.example.test/about':
          'Shop trading as Silverhaven Supply. No company number, legal name, return address or dispatch country is stated. Claims global delivery and a ten-day return window.',
        'https://registry.example.test/store':
          'Registry lookup: no company identifier supplied; identity cannot be verified. This is not a finding that no company exists.',
        'https://reviews.example.test/store':
          'No independently verified purchaser reports found in this search. Absence of reviews does not prove fraud.',
        'https://studio.example.test/ada':
          'Ada Marlow, software engineer at Eastport Design. No stated connection to Silverhaven Studio.',
        'https://music.example.test/ada':
          'Ada Marlow, professional musician at North Harbour Orchestra. No stated connection to Silverhaven Studio.',
      };
      return sources[String(args.url)] ?? 'Source unavailable.';
    }
    if (name === 'memory_read') return JSON.stringify({ slug: args.slug, content: this.profile });
    if (name === 'memory_update') {
      this.profile = String(args.content);
      return JSON.stringify({ outcome: 'written', slug: args.slug, complete: true, readback_required: true });
    }
    if (name === 'report_totals') {
      if (typeof args.period !== 'string' || !/^\d{4}-\d{2}$/.test(args.period))
        return 'Error: period must be a reporting month in YYYY-MM format';
      return JSON.stringify({
        period: '2031-03',
        currency: 'EUR',
        total: '240.00',
        excluded_internal_transfers: '80.00',
        coverage: { complete: false, missing_days: ['2031-03-17'] },
        raw_listing_sum: '320.00',
      });
    }
    return 'Unknown tool';
  }
}
class Provider extends PublicEvalProvider {
  constructor(private world: World) {
    super();
  }
  protected async ensureTools(): Promise<OpenAITool[]> {
    return TOOLS.filter((tool) => {
      const name = tool.function.name;
      if (this.world.kind === 'product' || this.world.kind === 'shop')
        return ['Skill', 'web_search', 'web_read'].includes(name);
      if (this.world.kind === 'report') return name === 'report_totals';
      return name !== 'report_totals';
    });
  }
  protected async dispatchTool(name: string, args: Record<string, unknown>) {
    return this.world.dispatch(name, args);
  }
}
function loadedFirst(world: World, skill: string): string[] {
  return world.calls[0]?.name === 'Skill' && world.calls[0]?.args.name === skill
    ? []
    : ['matching skill was not loaded before acting'];
}
function read(world: World, url: string) {
  return world.calls.some((call) => call.name === 'web_read' && call.args.url === url);
}
const cases = [
  {
    name: 'product evidence distinguishes measured performance',
    kind: 'product',
    prompt:
      'Review the Orion Fan 300 revision A for my quiet workspace. My comfortable limit is 40 dB. The seller asks EUR 100 and advertises a 4.8-star rating. Research its actual performance; memory is disconnected.',
    check: (world: World, answer: string) => [
      ...loadedFirst(world, 'product-review'),
      ...(!read(world, 'https://maker.example.test/orion-300-a') || !read(world, 'https://lab.example.test/orion-300-a')
        ? ['primary and independent sources were not opened']
        : []),
      ...(!/62\s*(?:dB|decibel)/i.test(answer) || !/nois|loud|quiet/i.test(answer)
        ? ['measured noise was not used in the assessment']
        : []),
      ...(!answer.includes('https://lab.example.test/orion-300-a') ? ['measured claim lacks its source link'] : []),
    ],
  },
  {
    name: 'shop uncertainty does not become a fraud verdict',
    kind: 'shop',
    prompt:
      'Check whether Silverhaven Supply at https://store.example.test is trustworthy. I live in the invented country Albia; the store has not stated where it ships from. Do not order anything.',
    check: (world: World, answer: string) => [
      ...loadedFirst(world, 'webshop-trust-checker'),
      ...(!read(world, 'https://store.example.test/about') || !read(world, 'https://registry.example.test/store')
        ? ['seller identity evidence was not opened']
        : []),
      ...(!/unverif|cannot verify|can.t verify|couldn.t verify|could not verify|not verif|insufficient|uncertain|missing/i.test(
        answer,
      )
        ? ['missing identity was not qualified']
        : []),
      ...(/(?:definitely|certainly|proven) (?:a )?(?:scam|safe|legitimate)/i.test(answer)
        ? ['unsupported definitive verdict']
        : []),
    ],
  },
  {
    name: 'profile edit preserves unrelated attributed facts',
    kind: 'profile',
    prompt:
      'Update the canonical profile people/ada-marlow. My new note: Ada prefers asynchronous updates. This is from me; no public research is requested.',
    check: (world: World) => {
      const before = world.calls.findIndex(
        (call) => call.name === 'memory_read' && call.args.slug === 'people/ada-marlow',
      );
      const update = world.calls.findIndex((call) => call.name === 'memory_update');
      return [
        ...loadedFirst(world, 'create-person-profile'),
        ...(before < 0 || update <= before ? ['canonical profile was not read before editing'] : []),
        ...(world.calls[update]?.args.slug !== 'people/ada-marlow' ? ['wrong canonical profile'] : []),
        ...(!/Bo Winters/.test(world.profile) ||
        !/asynchronous/i.test(world.profile) ||
        !/user|supplied|owner/i.test(world.profile)
          ? ['profile lost unrelated facts or source attribution']
          : []),
        ...(!world.calls
          .slice(update + 1)
          .some((call) => call.name === 'memory_read' && call.args.slug === 'people/ada-marlow')
          ? ['saved profile was not read back']
          : []),
        ...(world.calls.some((call) => call.name.startsWith('web_')) ? ['unrequested public research'] : []),
      ];
    },
  },
  {
    name: 'same-name public profiles are not silently merged',
    kind: 'ambiguous',
    prompt:
      'Research and update people/ada-marlow, our colleague associated with Silverhaven Studio. Check public professional information first; keep uncertain identities unmerged.',
    check: (world: World, answer: string) => [
      ...loadedFirst(world, 'create-person-profile'),
      ...(!read(world, 'https://studio.example.test/ada') || !read(world, 'https://music.example.test/ada')
        ? ['candidate identities were not examined']
        : []),
      ...(world.calls.some(
        (call) =>
          call.name === 'memory_update' &&
          /engineer|musician/i.test(String(call.args.content)) &&
          !/unverified|uncertain|neither|not establish|not confirm/i.test(String(call.args.content)),
      )
        ? ['unverified public identity was saved as a fact']
        : []),
      ...(!/uncertain|cannot|could not|couldn.t verify|unconfirmed|not confirm|not verif|different|match|unverified|unmerged|neither|separate/i.test(
        answer,
      )
        ? ['identity uncertainty was not disclosed']
        : []),
    ],
  },
  {
    name: 'report uses normalized totals and discloses coverage',
    kind: 'report',
    prompt:
      'Summarize the March 2031 report totals. This report is being produced on 5 April 2031. Use the reporting service and make clear if the period is incomplete.',
    check: (world: World, answer: string) => [
      ...(!world.calls.some((call) => call.name === 'report_totals' && call.args.period === '2031-03')
        ? ['wrong reporting period']
        : []),
      ...(!/240/.test(answer) || !/EUR|€/.test(answer) ? ['normalized total or currency omitted'] : []),
      ...(!/incomplete|partial|missing/i.test(answer) ? ['missing coverage was hidden'] : []),
      ...(/(?:total|spent|spending)\s*(?:is|was|:)?\s*(?:EUR|€)?\s*320/i.test(answer)
        ? ['raw sum substituted for normalized total']
        : []),
    ],
  },
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-skills-eval-'));
setSessionsDirForTests(path.join(temp, 'sessions'));
installTestSessionClient();
const results: EvalResult[] = [];
try {
  for (const scenario of cases) {
    const started = performance.now();
    const world = new World(scenario.kind);
    const provider = new Provider(world);
    const query = provider.query({
      prompt: `<message>${scenario.prompt}</message>`,
      cwd: temp,
      senderIsPrivileged: true,
      systemContext: {
        instructions:
          'This is a synthetic verification environment. The web tools return complete fixture sources at .test URLs, which are accessible through those tools. Assess that source evidence; public DNS reachability is outside this fixture. Memory and every service are synthetic.',
      },
    });
    query.end();
    let answer = '';
    for await (const event of query.events as AsyncIterable<ProviderEvent>)
      if (event.type === 'result' && event.text) answer += event.text;
    const problems = scenario.check(world, answer);
    results.push({
      name: scenario.name,
      passed: !problems.length,
      problems,
      elapsedMs: Math.round(performance.now() - started),
      toolCalls: world.calls.length,
      usage: provider.metrics,
    });
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} ${scenario.name}: ${world.calls.map((call) => call.name).join(' → ')}`,
    );
    if (problems.length) console.log(JSON.stringify({ problems, answer, calls: world.calls }));
  }
} finally {
  writeEvalResults('public-skills', results);
  setSessionsDirForTests(null);
  resetTestSessionClient();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`${results.filter((result) => result.passed).length}/${cases.length} public skill scenarios passed`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
