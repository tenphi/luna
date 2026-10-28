/**
 * Skill discovery + loading for the OpenAI provider.
 *
 * We scan two roots for `<name>/SKILL.md`, advertise each skill's frontmatter
 * (name + description) to the model, and expose a `Skill` tool that loads the
 * full instructions on demand:
 *
 *   1. Built-in skills — `~/.agents/skills/<name>` symlinks pointing at the
 *      read-only `/app/skills/<name>` mount (the per-group selection).
 *   2. Agent-authored skills — the writable workspace at
 *      `LUNA_AGENT_SKILLS_PATH` (default `/workspace/agent/skills`), which the
 *      agent manages itself via the `manage_skill` tool.
 *
 * Built-in skills take precedence on a name collision so the agent can never
 * shadow a shipped skill. Dangling/absent/invalid skills are simply skipped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type SkillSource = 'builtin' | 'workspace';

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path to the skill's SKILL.md. */
  file: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Where the skill was discovered: shipped built-in or agent-authored. */
  source: SkillSource;
}

function skillsRoot(home?: string): string {
  const base = home || process.env.HOME || os.homedir();
  return path.join(base, '.agents', 'skills');
}

/** Absolute path to the writable, agent-authored skills directory. */
export function workspaceSkillsRoot(): string {
  return process.env.LUNA_AGENT_SKILLS_PATH || '/workspace/agent/skills';
}

/**
 * Parse the leading YAML frontmatter block of a SKILL.md. We only need `name`
 * and `description`; a tiny hand-rolled parser avoids pulling in a YAML dep for
 * what is almost always a flat key: value block. Block scalars (`>`, `>-`, `|`,
 * `|-`) are folded so their indicator never leaks into the prompt as a value.
 * Returns null if there's no frontmatter delimited by `---` lines.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return out;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let value = line.slice(idx + 1).trim();

    if (/^[>|][+-]?$/.test(value)) {
      const indent = line.length - line.trimStart().length;
      const block: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '---') break;
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() !== '' && nextIndent <= indent) break;
        block.push(next.trim());
        i++;
      }
      out[key] = block.join(' ').trim();
      continue;
    }

    // Strip matching surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  // No closing delimiter — not valid frontmatter.
  return null;
}

/**
 * Scan a single skills root for `<name>/SKILL.md` entries. Follows symlinks
 * (the built-in per-group selection is symlinks to `/app/skills/<name>`);
 * entries without a readable SKILL.md or without a `name` in frontmatter are
 * skipped. Returns entries unsorted — callers merge and sort.
 */
function scanSkillsDir(root: string, source: SkillSource): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    let dir: string;
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory()) continue;
      dir = entryPath;
    } catch {
      continue;
    }

    const file = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    const name = fm?.name?.trim() || entry.name;
    const description = fm?.description?.trim() || '';
    if (!name) continue;
    skills.push({ name, description, file, dir, source });
  }

  return skills;
}

/**
 * Discover all skills available to this session. Scans the built-in root
 * (`~/.agents/skills`) and the writable workspace root
 * (`LUNA_AGENT_SKILLS_PATH`). Built-in skills win on a name collision so the
 * agent can never shadow a shipped skill. Results are sorted by name for stable
 * prompt output. `home` is overridable for testing; `workspaceRoot` overrides
 * the workspace scan path (defaults to `workspaceSkillsRoot()`).
 */
export function discoverSkills(home?: string, workspaceRoot?: string): SkillInfo[] {
  const builtin = scanSkillsDir(skillsRoot(home), 'builtin');
  const workspace = scanSkillsDir(workspaceRoot ?? workspaceSkillsRoot(), 'workspace');

  const byName = new Map<string, SkillInfo>();
  // Built-in first so authored skills with a colliding name are dropped.
  for (const skill of builtin) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  for (const skill of workspace) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }

  const skills = [...byName.values()];
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Render the skill catalog for the system prompt. Mirrors the progressive-
 * disclosure framing Claude uses: list name + description, and tell the model
 * to call the `Skill` tool to load full instructions before acting. Returns an
 * empty string when no skills are available so the prompt stays clean.
 */
export function formatSkillCatalog(skills: SkillInfo[]): string {
  if (skills.length === 0) return '';
  const lines = [
    '# Skills',
    '',
    'You have access to the following skills. Each is a focused workflow with detailed instructions.',
    'When a task matches a skill, call the `Skill` tool with its `name` to load the full instructions BEFORE acting — do not guess at the steps.',
    '',
  ];
  for (const s of skills) {
    lines.push(`- **${s.name}** — ${s.description || '(no description)'}`);
  }
  return lines.join('\n');
}

export interface LoadedSkill {
  name: string;
  /** Full SKILL.md contents (frontmatter included). */
  content: string;
  /** Bundled files in the skill dir (relative paths), excluding SKILL.md. */
  files: string[];
}

/** Match legacy `mcp__server__tool` references in skill bodies. */
const MCP_LEGACY_REF_RE = /mcp__([A-Za-z0-9][A-Za-z0-9_-]*?)__/g;

/**
 * Parse `requires_mcp` from skill frontmatter (comma/space-separated server
 * names) and/or infer servers from `mcp__server__…` references in the body.
 * Used to refuse loading a skill whose MCP deps are not connected.
 */
export function requiredMcpServersFromSkill(content: string): string[] {
  const names = new Set<string>();
  const fm = parseFrontmatter(content);
  const declared = fm?.requires_mcp?.trim();
  if (declared) {
    for (const part of declared.split(/[,;\s]+/)) {
      const name = part.trim();
      if (name) names.add(name);
    }
  }
  MCP_LEGACY_REF_RE.lastIndex = 0;
  for (const m of content.matchAll(MCP_LEGACY_REF_RE)) {
    const server = m[1]?.trim();
    if (server) names.add(server);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface SkillMcpServerStatus {
  server: string;
  /** True when the server is listed in container mcpServers with a command. */
  configured: boolean;
  /** True when the MCP bridge has an open client for this server. */
  connected: boolean;
  /** Connect failure message when configured but not connected. */
  connectError?: string;
}

/**
 * Build a tool-result error when a skill's required MCP servers are missing.
 * Forces the model to tell the user instead of inventing the workflow.
 */
export function formatSkillMcpPrerequisiteError(
  skillName: string,
  problems: SkillMcpServerStatus[],
): string {
  const lines = [
    `Error: skill "${skillName}" requires MCP server(s) that are not available right now.`,
    '',
  ];
  for (const p of problems) {
    if (!p.configured) {
      lines.push(
        `- **${p.server}**: not wired for this agent group (no host MCP / agent mcpServers entry).`,
      );
    } else if (p.connectError) {
      lines.push(`- **${p.server}**: configured but failed to connect: ${p.connectError}`);
    } else {
      lines.push(`- **${p.server}**: configured but not connected (no tools exposed).`);
    }
  }
  lines.push(
    '',
    'Tell the user these MCP servers must be fixed before this skill can run.',
    'Do not invent data, do not pretend to call those tools, and do not continue the skill workflow.',
  );
  return lines.join('\n');
}

function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) {
        walk(full);
      } else {
        const rel = path.relative(dir, full);
        if (rel !== 'SKILL.md') out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Load a skill's full instructions on demand. Returns null if no skill with
 * that name is currently available (so the tool can report it cleanly).
 * `home` and `workspaceRoot` are overridable for testing.
 */
export function loadSkill(name: string, home?: string, workspaceRoot?: string): LoadedSkill | null {
  const skills = discoverSkills(home, workspaceRoot);
  const skill = skills.find((s) => s.name === name);
  if (!skill) return null;
  let content: string;
  try {
    content = fs.readFileSync(skill.file, 'utf-8');
  } catch {
    return null;
  }
  return { name: skill.name, content, files: listSkillFiles(skill.dir) };
}
