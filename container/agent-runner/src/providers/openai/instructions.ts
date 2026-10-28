/**
 * Instruction assembly for the OpenAI provider.
 *
 * A raw OpenAI endpoint has no built-in instruction loader, so we flatten the
 * composed `/workspace/agent/AGENTS.md` import graph by hand and fold it into
 * a single system message.
 *
 * The composed entry (`src/agents-md-compose.ts`) is import-only:
 *   <!-- header -->
 *   @./.agents-shared.md
 *   @./.agents-fragments/<name>
 *   ...
 *
 * `.agents-shared.md` symlinks the shared base (`/app/AGENTS.md`); each
 * fragment symlinks a skill/MCP `instructions.md`. We resolve `@./` imports
 * relative to the importing file, deduplicate, and append the per-group
 * memory file (`AGENTS.local.md`).
 *
 * Finally we fold in a skill catalog (name + description for every skill in
 * `$HOME/.agents/skills`) and pair it with the `Skill` built-in tool (see
 * `tools/builtin.ts` + `skills.ts`) that loads a skill's full instructions
 * on demand.
 */
import fs from 'fs';
import path from 'path';

import { discoverSkills, formatSkillCatalog } from './skills.js';

const AGENT_DIR = '/workspace/agent';
const IMPORT_RE = /^@(\.\/[^\s]+)\s*$/;
const MAX_IMPORT_DEPTH = 8;

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

function readFileSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Recursively expand a markdown file, inlining `@./relative` imports. Each
 * file is visited at most once (by resolved path) so symlink cycles or
 * repeated fragments don't duplicate content or loop forever.
 */
function expand(file: string, seen: Set<string>, depth: number, out: string[]): void {
  let resolved: string;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    resolved = path.resolve(file);
  }
  if (seen.has(resolved)) return;
  seen.add(resolved);

  const content = readFileSafe(file);
  if (content === null) return;
  if (depth > MAX_IMPORT_DEPTH) {
    out.push(content);
    return;
  }

  const dir = path.dirname(file);
  for (const line of content.split('\n')) {
    const m = line.match(IMPORT_RE);
    if (m) {
      expand(path.resolve(dir, m[1]), seen, depth + 1, out);
    } else if (line.trim().startsWith('<!--')) {
      // Skip the "composed at spawn" header comment.
      continue;
    } else {
      out.push(line);
    }
  }
}

/**
 * Build the full system prompt for an OpenAI-driven turn: the runtime
 * addendum (identity + destinations) first, then the flattened AGENTS.md
 * import graph, then per-group memory.
 *
 * `agentDir`/`sharedBasePath` are overridable for testing; production uses the
 * mounted defaults.
 */
export function buildSystemPrompt(
  addendum?: string,
  agentDir: string = AGENT_DIR,
  sharedBasePath = '/app/AGENTS.md',
  skillsHome?: string,
  workspaceSkillsPath?: string,
): string {
  const sections: string[] = [];

  if (addendum && addendum.trim()) {
    sections.push(addendum.trim());
  }

  const seen = new Set<string>();
  const composed = path.join(agentDir, 'AGENTS.md');
  if (fs.existsSync(composed)) {
    const out: string[] = [];
    expand(composed, seen, 0, out);
    const body = out.join('\n').trim();
    if (body) sections.push(body);
  } else if (fs.existsSync(sharedBasePath)) {
    // No composed entry (e.g. minimal/test group) — fall back to the shared
    // base directly if it's mounted.
    const base = readFileSafe(sharedBasePath);
    if (base?.trim()) sections.push(base.trim());
  }

  const localMemory = path.join(agentDir, 'AGENTS.local.md');
  const local = readFileSafe(localMemory);
  if (local?.trim()) {
    sections.push(`# Per-group memory (AGENTS.local.md)\n\n${local.trim()}`);
  }

  // Skill catalog — name + description only. Full instructions are loaded on
  // demand via the `Skill` tool.
  const skills = discoverSkills(skillsHome, workspaceSkillsPath);
  const catalog = formatSkillCatalog(skills);
  if (catalog) {
    sections.push(catalog);
    log(`Advertised ${skills.length} skill(s) in system prompt`);
  }

  const prompt = sections.join('\n\n---\n\n');
  log(`Assembled system prompt: ${prompt.length} chars from ${sections.length} section(s)`);
  return prompt;
}
