/**
 * Skill self-management MCP tool: manage_skill.
 *
 * Lets the agent create, update, delete, list, and read its OWN skills —
 * reusable workflows stored as files under the writable workspace
 * (`LUNA_AGENT_SKILLS_PATH`, default `/workspace/agent/skills`). Needs no host
 * round-trip and no approval: the workspace is writable and skills are
 * re-discovered every turn, so an authored skill is advertised in the Skills
 * catalog on the next turn. (The memory agent's `create_skill` path in
 * `src/modules/memory-mod/` is the approval-gated one — this is not it.)
 *
 * This tool is for WRITING skills. Reading/loading an existing skill's full
 * instructions is the separate built-in `Skill` tool.
 *
 * Built-in shipped skills are read-only and cannot be created over, updated, or
 * deleted here — the tool rejects any name that collides with a built-in.
 *
 * Authored skills are identified by frontmatter `name` (catalog identity), which
 * may differ from the on-disk folder name for hand-placed skills. Create still
 * writes to `<root>/<name>/` with matching frontmatter.
 */
import fs from 'fs';
import path from 'path';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Writable, agent-authored skills directory. */
function workspaceSkillsRoot(): string {
  return process.env.LUNA_AGENT_SKILLS_PATH || '/workspace/agent/skills';
}

/** Read-only shipped skills directory (full set, incl. disabled). */
function builtinSkillsRoot(): string {
  return process.env.LUNA_BUILTIN_SKILLS_PATH || '/app/skills';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME_LEN = 64;
const MAX_BODY_LINES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 20;

function isBuiltinSkill(name: string): boolean {
  try {
    return fs.statSync(path.join(builtinSkillsRoot(), name)).isDirectory();
  } catch {
    return false;
  }
}

/** Validate a skill name; returns an error string or null when valid. */
function validateName(name: unknown): { name: string } | { error: string } {
  if (typeof name !== 'string' || name.trim() === '') return { error: '`name` is required' };
  const value = name.trim();
  if (value.length > MAX_NAME_LEN) return { error: `\`name\` must be ≤ ${MAX_NAME_LEN} characters` };
  if (!NAME_RE.test(value)) {
    return {
      error: `Invalid \`name\` "${value}". Use lowercase letters, digits, and hyphens; must start with a letter or digit.`,
    };
  }
  return { name: value };
}

/** Validate an optional relative file path for a bundled skill file. */
function validateRelPath(rel: string): string | null {
  if (rel.startsWith('/') || rel.includes('\0')) return `Invalid file path "${rel}"`;
  const normalized = path.normalize(rel);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`) || normalized === 'SKILL.md') {
    return `Invalid file path "${rel}" (no traversal; SKILL.md is managed via body)`;
  }
  return null;
}

export interface ParsedSkillFile {
  /** Catalog name from frontmatter, or empty when absent. */
  name: string;
  description: string;
  body: string;
  /** Extra frontmatter keys besides name/description, in file order. */
  extra: Array<{ key: string; value: string }>;
}

/** Parse a SKILL.md into name, description, body, and extra frontmatter. */
function parseSkillFile(content: string): ParsedSkillFile {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { name: '', description: '', body: content, extra: [] };

  let name = '';
  let description = '';
  const extra: Array<{ key: string; value: string }> = [];
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      i++;
      break;
    }
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const key = lines[i].slice(0, idx).trim();
    let value = lines[i].slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
    else if (key) extra.push({ key, value });
  }
  // Skip a single blank line after frontmatter for a clean body.
  if (lines[i]?.trim() === '') i++;
  return { name, description, body: lines.slice(i).join('\n'), extra };
}

function renderSkillFile(
  name: string,
  description: string,
  body: string,
  extra: Array<{ key: string; value: string }> = [],
): string {
  const desc = description.replace(/\r?\n/g, ' ').trim();
  const trimmedBody = body.replace(/\s+$/, '');
  const lines = [`---`, `name: ${name}`, `description: ${desc}`];
  for (const { key, value } of extra) {
    if (key === 'name' || key === 'description') continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '', trimmedBody, '');
  return lines.join('\n');
}

interface AuthoredSkill {
  /** Catalog identity (frontmatter name, else folder name). */
  name: string;
  description: string;
  dir: string;
}

/**
 * Scan workspace skills by catalog name (frontmatter `name`, falling back to
 * the folder name). First match wins on a catalog-name collision.
 */
function scanAuthoredSkills(): AuthoredSkill[] {
  const root = workspaceSkillsRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const byName = new Map<string, AuthoredSkill>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseSkillFile(content);
    const name = parsed.name.trim() || entry.name;
    if (!name || byName.has(name)) continue;
    byName.set(name, { name, description: parsed.description, dir });
  }

  const out = [...byName.values()];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Resolve an authored skill directory by catalog name, or null if missing. */
function findAuthoredSkill(name: string): AuthoredSkill | null {
  return scanAuthoredSkills().find((s) => s.name === name) ?? null;
}

function listAuthoredSkills(): { name: string; description: string }[] {
  return scanAuthoredSkills().map(({ name, description }) => ({ name, description }));
}

/** Directory used when creating a new skill (folder name === catalog name). */
function createSkillDir(name: string): string {
  return path.join(workspaceSkillsRoot(), name);
}

function writeBundledFiles(dir: string, files: Record<string, unknown>): string | null {
  const names = Object.keys(files);
  if (names.length > MAX_FILES) return `Too many files (max ${MAX_FILES})`;
  for (const rel of names) {
    const relErr = validateRelPath(rel);
    if (relErr) return relErr;
    const content = files[rel];
    if (typeof content !== 'string') return `File "${rel}" content must be a string`;
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      return `File "${rel}" exceeds ${MAX_FILE_BYTES} bytes`;
    }
  }
  for (const rel of names) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[rel] as string);
  }
  return null;
}

export const manageSkill: McpToolDefinition = {
  tool: {
    name: 'manage_skill',
    description:
      'Write your own skills — reusable workflows, live in your Skills catalog on the next turn. Use the `Skill` tool to read/load one. Built-in skills are read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list', 'read'],
          description: 'list/read cover your authored skills only.',
        },
        name: {
          type: 'string',
          description: 'Lowercase letters, digits, hyphens. Required except for list.',
        },
        description: {
          type: 'string',
          description: 'One-line catalog summary telling you later when to load it. Required on create.',
        },
        body: {
          type: 'string',
          description: 'SKILL.md body in Markdown, no frontmatter. Required on create; replaces the body on update.',
        },
        files: {
          type: 'object',
          description: 'Bundled sibling files as { "relative/path": "contents" }. Cannot include SKILL.md.',
        },
      },
      required: ['action'],
    },
  },
  async handler(args) {
    const action = args.action as string;

    if (action === 'list') {
      const skills = listAuthoredSkills();
      if (skills.length === 0) return ok('You have not authored any skills yet. Use action "create" to add one.');
      const lines = skills.map((s) => `- ${s.name} — ${s.description || '(no description)'}`);
      return ok(`Your authored skills:\n${lines.join('\n')}`);
    }

    const nameResult = validateName(args.name);
    if ('error' in nameResult) return err(nameResult.error);
    const name = nameResult.name;

    if (isBuiltinSkill(name)) {
      return err(`"${name}" is a built-in skill and is read-only. Choose a different name for your own skill.`);
    }

    if (action === 'read') {
      const skill = findAuthoredSkill(name);
      if (!skill) return err(`No authored skill named "${name}". Use action "list" to see yours.`);
      const content = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf-8');
      const files = fs
        .readdirSync(skill.dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name !== 'SKILL.md')
        .map((e) => e.name)
        .sort();
      const filesNote = files.length > 0 ? `\n\nBundled files: ${files.join(', ')}` : '';
      return ok(`${content}${filesNote}`);
    }

    if (action === 'delete') {
      const skill = findAuthoredSkill(name);
      if (!skill) return err(`No authored skill named "${name}" to delete.`);
      fs.rmSync(skill.dir, { recursive: true, force: true });
      log(`manage_skill: deleted "${name}"`);
      return ok(`Deleted skill "${name}". It is removed from your Skills catalog on the next turn.`);
    }

    if (action === 'create' || action === 'update') {
      const bodyArg = args.body;
      const descArg = args.description;
      const files = (args.files as Record<string, unknown> | undefined) ?? undefined;

      const existing = findAuthoredSkill(name);
      if (action === 'create' && existing) {
        return err(`Skill "${name}" already exists. Use action "update" to change it.`);
      }
      if (action === 'update' && !existing) {
        return err(`No authored skill named "${name}" to update. Use action "create" to add it.`);
      }

      let description: string;
      let body: string;
      let extra: Array<{ key: string; value: string }> = [];
      if (action === 'create') {
        if (typeof descArg !== 'string' || descArg.trim() === '') return err('`description` is required on create.');
        if (typeof bodyArg !== 'string' || bodyArg.trim() === '') return err('`body` is required on create.');
        description = descArg;
        body = bodyArg;
      } else {
        const current = parseSkillFile(fs.readFileSync(path.join(existing!.dir, 'SKILL.md'), 'utf-8'));
        description = typeof descArg === 'string' && descArg.trim() !== '' ? descArg : current.description;
        body = typeof bodyArg === 'string' ? bodyArg : current.body;
        extra = current.extra;
        if (descArg === undefined && bodyArg === undefined && files === undefined) {
          return err('Nothing to update — provide `description`, `body`, and/or `files`.');
        }
      }

      const bodyLines = body.split('\n').length;
      if (bodyLines > MAX_BODY_LINES) {
        return err(
          `Skill body is ${bodyLines} lines (max ${MAX_BODY_LINES}). Keep skills focused; move long reference material into bundled \`files\` and point to them.`,
        );
      }

      const dir = action === 'create' ? createSkillDir(name) : existing!.dir;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillFile(name, description, body, extra));

      if (files) {
        const fileErr = writeBundledFiles(dir, files);
        if (fileErr) return err(fileErr);
      }

      log(`manage_skill: ${action}d "${name}"`);
      const verb = action === 'create' ? 'Created' : 'Updated';
      return ok(
        `${verb} skill "${name}". It will appear in your Skills catalog on the next turn — load it with the \`Skill\` tool to confirm.`,
      );
    }

    return err(`Unknown action "${action}". Use create, update, delete, list, or read.`);
  },
};

registerTools([manageSkill]);
