/** Repository-only context for opt-in live tests. Never reads an installed agent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { OpenAIProvider } from '../providers/openai/index.js';
import { buildSystemPrompt } from '../providers/openai/instructions.js';
import { loadSkill } from '../providers/openai/skills.js';

export function createPublicContext(root = path.resolve(import.meta.dir, '../../../../')) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-public-context-'));
  const agent = path.join(scratch, 'agent');
  const home = path.join(scratch, 'home');
  const skills = path.join(home, '.agents/skills');
  const workspaceSkills = path.join(agent, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(workspaceSkills, { recursive: true });
  const imports: string[] = [];
  const assets: Record<string, string> = {};
  const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
  const include = (relative: string) => {
    const content = fs.readFileSync(path.join(root, relative));
    assets[relative] = hash(content);
    const target = `instruction-${imports.length}.md`;
    fs.writeFileSync(path.join(agent, target), content);
    imports.push(`@./${target}`);
  };
  include('container/AGENTS.md');
  for (const name of ['tools', 'memory', 'reminders', 'episodes']) include(`container/fragments/${name}.md`);
  include('container/agent-runner/src/mcp-tools/core.instructions.md');
  for (const name of fs.readdirSync(path.join(root, 'container/skills')).sort()) {
    const directory = path.join(root, 'container/skills', name);
    if (!fs.statSync(directory).isDirectory()) continue;
    const file = path.join(directory, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    assets[`container/skills/${name}/SKILL.md`] = hash(fs.readFileSync(file));
    fs.symlinkSync(directory, path.join(skills, name));
    if (fs.existsSync(path.join(directory, 'instructions.md'))) include(`container/skills/${name}/instructions.md`);
  }
  fs.writeFileSync(path.join(agent, 'AGENTS.md'), imports.join('\n'));
  const prompt = (addendum?: string) => buildSystemPrompt(addendum, agent, '', home, workspaceSkills);
  return {
    prompt,
    manifest: { assets, systemPromptSha256: hash(prompt()) },
    skill: (name: string) => loadSkill(name, home, workspaceSkills),
    dispose: () => fs.rmSync(scratch, { recursive: true, force: true }),
  };
}

let context: ReturnType<typeof createPublicContext> | undefined;
export function publicContext() {
  return (context ??= createPublicContext());
}

export class PublicEvalProvider extends OpenAIProvider {
  metrics = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    efforts: [] as string[],
  };
  constructor() {
    super({
      model: process.env.OPENAI_MODEL || 'gpt-6-luna',
      effort: 'adaptive',
      mcpServers: {},
      memory: { autoRecall: false },
    });
    if (!this.client.responses) throw new Error('Public evaluation requires the Responses transport');
    const create = this.client.responses.create.bind(this.client.responses);
    const metrics = this.metrics;
    const capture = (value: unknown) => {
      const data = value as { type?: string; response?: { usage?: unknown }; usage?: unknown };
      const usage = (data.type === 'response.completed' ? data.response?.usage : data.usage) as
        | {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
            output_tokens_details?: { reasoning_tokens?: number };
          }
        | undefined;
      if (!usage) return;
      metrics.inputTokens += usage.input_tokens ?? 0;
      metrics.outputTokens += usage.output_tokens ?? 0;
      metrics.cachedTokens += usage.input_tokens_details?.cached_tokens ?? 0;
      metrics.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
    };
    this.client.responses.create = async (params, options) => {
      metrics.requests++;
      const effort = (params.reasoning as { effort?: string } | undefined)?.effort;
      if (effort) metrics.efforts.push(effort);
      const response = await create(params, options);
      if (response && typeof response === 'object' && Symbol.asyncIterator in response) {
        return (async function* () {
          for await (const chunk of response as AsyncIterable<unknown>) {
            capture(chunk);
            yield chunk;
          }
        })();
      }
      capture(response);
      return response;
    };
  }
  protected assembleSystemPrompt(addendum?: string): string {
    return publicContext().prompt(addendum);
  }
}

export interface EvalResult {
  decision?: { effort: string; source: string; elapsedMs: number };
  name: string;
  passed: boolean;
  problems: string[];
  elapsedMs: number;
  toolCalls: number;
  usage?: PublicEvalProvider['metrics'];
}

export function writeEvalResults(family: string, results: EvalResult[]): void {
  if (process.env.LUNA_EVAL_RESULTS_PATH) {
    fs.writeFileSync(
      process.env.LUNA_EVAL_RESULTS_PATH,
      JSON.stringify({ family, context: publicContext().manifest, results }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  context?.dispose();
  context = undefined;
}
