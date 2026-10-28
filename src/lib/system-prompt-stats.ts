/**
 * Measure Luna system-prompt size by category for an agent group.
 *
 * Reports character counts (and optional token estimates) for:
 *   - system-prompt instruction sources (AGENTS.md graph, runtime addendum)
 *   - container/skills/SKILL.md catalog metadata (name + description; folded into
 *     the system message)
 *   - tool definitions sent on every turn (built-ins + MCP servers)
 *
 * Usage:
 *   luna system-prompt-stats [--session] [--tokens] [--json]
 *   pnpm exec tsx scripts/measure-system-prompt.ts  (legacy wrapper)
 *
 * Options:
 *   --inbound <path>    Use destinations from a session inbound.db for runtime addendum
 *   --session           Pick the newest inbound.db for this group's install agent
 *   --no-runtime        Omit runtime addendum (identity + destinations)
 *   --no-mcp            Skip MCP tool probing (requires Bun; see below)
 *   --tokens            Also print ~token estimate (chars / 4)
 *   --json              Machine-readable output
 *
 * MCP tool sizes are measured by `container/agent-runner/scripts/dump-tool-schemas.ts`
 * (run via `bun`). Config comes from unified `config/local.jsonc` (legacy
 * `agent/container.json` is not required). External servers are probed on the host
 * when their commands are available; otherwise they appear with an error and 0 chars.
 */
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { composeAgentsMd } from '../agents-md-compose.js';
import { CENTRAL_DB_PATH, SESSIONS_DIR as CONFIG_SESSIONS_DIR } from '../config.js';
import { getAgentDir } from '../install-paths.js';
import { getTheAgent } from '../bootstrap.js';
import { containerConfigForToolProbe, readStoredContainerConfig } from '../container-config.js';
import type { AgentGroup } from '../types.js';
import { resolveContainerSkills } from '../container-skills.js';
import { getDb, initDb } from '../db/connection.js';
import { initializeCentralSchema } from '../db/initialize.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED_AGENTS_MD = path.join(PROJECT_ROOT, 'container', 'AGENTS.md');
const SESSIONS_DIR = CONFIG_SESSIONS_DIR;
const IMPORT_RE = /^@(\.\/[^\s]+)\s*$/;

interface ContainerJson {
  assistantName?: string;
  cli_scope?: string;
  skills?: string[] | 'all';
  skillsDisabled?: string[];
  skills_disabled?: string[];
  skillsEnabled?: string[];
  skills_enabled?: string[];
  mcpServers?: Record<string, { instructions?: string }>;
}

interface DestinationEntry {
  name: string;
  displayName: string;
  channelType?: string;
}

interface CategoryRow {
  category: string;
  name: string;
  chars: number;
  path: string;
}

interface ToolProbeRow {
  server: string;
  tool: string;
  exposedName: string;
  chars: number;
}

interface ToolProbeResult {
  builtin: { tools: ToolProbeRow[]; totalChars: number };
  mcp: {
    servers: Record<string, { tools: ToolProbeRow[]; totalChars: number; error?: string }>;
    totalChars: number;
  };
  grandTotalChars: number;
}

export interface MeasureResult {
  providerNote: string;
  categories: CategoryRow[];
  runtimeAddendum: { included: boolean; chars: number; source?: string };
  /** Flattened AGENTS.md graph + runtime addendum + local memory (excludes skill catalog block). */
  instructions: { chars: number };
  /** Full `# Skills` catalog block folded into the system message. */
  skillCatalogBlock: { chars: number };
  systemPrompt: { chars: number; sections: number };
  /** Per-skill catalog lines (name + description only). */
  skillCatalog: CategoryRow[];
  tools: ToolProbeResult | { skipped: true; reason: string };
  contextTotal: number;
  sumInstructionChars: number;
}

const PROMPT_SECTION_SEP = '\n\n---\n\n';

const DUMP_TOOL_SCHEMAS = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'scripts', 'dump-tool-schemas.ts');

const OPENAI_PROVIDER_DIR = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'src', 'providers', 'openai');

async function loadOpenAiProviderModules(): Promise<{
  buildSystemPrompt: (
    runtimeAddendum: string | undefined,
    agentDir: string,
    sharedAgentsMd: string,
    skillsHome: string,
  ) => string;
  discoverSkills: (skillsHome: string) => Array<{ name: string; description: string; dir: string }>;
  formatSkillCatalog: (skills: Array<{ name: string; description: string; dir: string }>) => string;
}> {
  const [instructions, skills] = await Promise.all([
    import(pathToFileURL(path.join(OPENAI_PROVIDER_DIR, 'instructions.ts')).href),
    import(pathToFileURL(path.join(OPENAI_PROVIDER_DIR, 'skills.ts')).href),
  ]);
  return {
    buildSystemPrompt: instructions.buildSystemPrompt,
    discoverSkills: skills.discoverSkills,
    formatSkillCatalog: skills.formatSkillCatalog,
  };
}

function usage(): never {
  console.error(`Usage: pnpm exec tsx scripts/measure-system-prompt.ts [options]

Options:
  --inbound <path>    Session inbound.db for live destinations addendum
  --session           Newest inbound.db for the install agent
  --no-runtime        Skip runtime addendum
  --no-mcp            Skip tool-definition measurement
  --tokens            Show ~token estimate (chars / 4)
  --json              JSON output`);
  process.exit(2);
}

export interface MeasureOptions {
  inbound?: string;
  useSession: boolean;
  noRuntime: boolean;
  noMcp: boolean;
  tokens: boolean;
  json: boolean;
}

export function parseMeasureArgs(argv: string[]): MeasureOptions {
  const opts: MeasureOptions = {
    inbound: undefined as string | undefined,
    useSession: false,
    noRuntime: false,
    noMcp: false,
    tokens: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session') {
      opts.useSession = true;
    } else if (arg === '--no-runtime') {
      opts.noRuntime = true;
    } else if (arg === '--no-mcp') {
      opts.noMcp = true;
    } else if (arg === '--tokens') {
      opts.tokens = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--inbound') {
      const next = argv[++i];
      if (!next) usage();
      opts.inbound = path.resolve(next);
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      usage();
    } else {
      console.error(`Unexpected argument: ${arg}`);
      usage();
    }
  }

  return opts;
}

/** Mirrors `syncSkillSymlinks()` in container-runner.ts. */
function resolveEnabledContainerSkills(containerJson: ContainerJson): string[] {
  return resolveContainerSkills(
    {
      skills: containerJson.skills ?? 'all',
      skillsDisabled: containerJson.skillsDisabled ?? containerJson.skills_disabled,
      skillsEnabled: containerJson.skillsEnabled ?? containerJson.skills_enabled,
    },
    PROJECT_ROOT,
  );
}

/**
 * Skill catalog lines folded into the system message (name + description only).
 * Full SKILL.md bodies load on invoke via the Skill tool — not counted here.
 */
async function measureSkillCatalog(skillsHome: string): Promise<CategoryRow[]> {
  const { discoverSkills } = await loadOpenAiProviderModules();
  return discoverSkills(skillsHome).map((skill) => {
    const skillFolder = path.basename(skill.dir);
    const line = `- **${skill.name}** — ${skill.description || '(no description)'}`;
    return {
      category: 'skill_catalog',
      name: skill.name,
      chars: line.length,
      path: `container/skills/${skillFolder}/SKILL.md (name + description only)`,
    };
  });
}

function ensureDb(): void {
  const dbPath = CENTRAL_DB_PATH;
  if (!fs.existsSync(dbPath)) return;
  try {
    getDb();
  } catch {
    const db = initDb(dbPath);
    initializeCentralSchema(db);
  }
}

function resolveComposedPath(groupDir: string): string | null {
  const p = path.join(groupDir, 'AGENTS.md');
  return fs.existsSync(p) ? p : null;
}

function resolveLocalPath(groupDir: string): string | null {
  const p = path.join(groupDir, 'AGENTS.local.md');
  return fs.existsSync(p) ? p : null;
}

/** Stage $HOME/.agents/skills/<name> → container/skills/<name> for discoverSkills(). */
function stageSkillsHome(homeDir: string, enabledSkills: string[]): void {
  const skillsRoot = path.join(homeDir, '.agents', 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  for (const skillName of enabledSkills) {
    const src = path.join(PROJECT_ROOT, 'container', 'skills', skillName);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(skillsRoot, skillName);
    try {
      fs.symlinkSync(src, dest, 'dir');
    } catch {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}

/** Map container mount paths from compose-time symlinks to host source files. */
function resolveContainerPathToHost(target: string): string | null {
  if (target === '/app/AGENTS.md') return SHARED_AGENTS_MD;
  if (target.startsWith('/app/container-tree/')) {
    return path.join(PROJECT_ROOT, 'container', target.slice('/app/container-tree/'.length));
  }
  if (target.startsWith('/app/skills/')) {
    return path.join(PROJECT_ROOT, 'container', 'skills', target.slice('/app/skills/'.length));
  }
  if (target.startsWith('/app/src/mcp-tools/')) {
    return path.join(
      PROJECT_ROOT,
      'container',
      'agent-runner',
      'src',
      'mcp-tools',
      target.slice('/app/src/mcp-tools/'.length),
    );
  }
  return null;
}

function charCount(filePath: string): number {
  return fs.readFileSync(filePath, 'utf-8').trimEnd().length;
}

function parseComposedImports(agentsMdPath: string): string[] {
  if (!fs.existsSync(agentsMdPath)) return [];
  const imports: string[] = [];
  for (const line of fs.readFileSync(agentsMdPath, 'utf-8').split('\n')) {
    const m = line.match(IMPORT_RE);
    if (m) imports.push(m[1]);
  }
  return imports;
}

function categoryForFragment(importPath: string): { category: string; name: string } {
  if (importPath === './.agents-shared.md' || importPath.endsWith('.agents-shared.md')) {
    return { category: 'shared_base', name: 'container/AGENTS.md' };
  }
  const frag = path.basename(importPath, '.md');
  if (frag.startsWith('skill-')) return { category: 'skill', name: frag.slice('skill-'.length) };
  if (frag.startsWith('module-')) return { category: 'module', name: frag.slice('module-'.length) };
  if (frag.startsWith('mcp-')) return { category: 'mcp', name: frag.slice('mcp-'.length) };
  return { category: 'fragment', name: frag };
}

/** Resolve a fragment path; container symlinks are dangling on the host. */
function resolveFragmentHostPath(groupDir: string, fragFileName: string): string | null {
  const fragOnDisk = path.join(groupDir, '.agents-fragments', fragFileName);
  try {
    const stat = fs.lstatSync(fragOnDisk);
    if (stat.isSymbolicLink()) {
      const host = resolveContainerPathToHost(fs.readlinkSync(fragOnDisk));
      if (host) return host;
    }
    if (stat.isFile()) return fragOnDisk;
  } catch {
    /* missing */
  }
  return null;
}

function loadDestinations(inboundPath: string): DestinationEntry[] {
  const db = new Database(inboundPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT name, display_name, channel_type FROM destinations ORDER BY name').all() as {
      name: string;
      display_name: string | null;
      channel_type: string | null;
    }[];
    return rows.map((r) => ({
      name: r.name,
      displayName: r.display_name ?? r.name,
      channelType: r.channel_type ?? undefined,
    }));
  } finally {
    db.close();
  }
}

/** Mirrors container/agent-runner/src/destinations.ts (no bun:sqlite dependency). */
function buildRuntimeAddendum(assistantName: string | undefined, destinations: DestinationEntry[]): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(
      [
        '# You are ' + assistantName,
        '',
        `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`,
      ].join('\n'),
    );
  }

  if (destinations.length === 0) {
    sections.push(
      [
        '## Sending messages',
        '',
        'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
      ].join('\n'),
    );
  } else {
    const lines = ['## Sending messages', ''];
    if (destinations.length === 1) {
      const d = destinations[0];
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`Your destination is \`${d.name}\`${label}.`);
    } else {
      lines.push('You can send messages to the following destinations:', '');
      for (const d of destinations) {
        const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
        lines.push(`- \`${d.name}\`${label}`);
      }
    }
    lines.push('');
    lines.push(
      'When replying to an incoming message, default to the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute).',
    );
    if (destinations.some((d) => d.channelType === 'telegram')) {
      lines.push('');
      lines.push(
        'Telegram destinations render **GitHub-flavored markdown** (Rich Markdown): write GFM, never HTML or MarkdownV2 escaping.',
      );
    }
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function findSessionInbound(agentGroupId: string): string | null {
  const base = path.join(SESSIONS_DIR, agentGroupId);
  if (!fs.existsSync(base)) return null;

  let newest: { path: string; mtime: number } | null = null;
  for (const sess of fs.readdirSync(base, { withFileTypes: true })) {
    if (!sess.isDirectory()) continue;
    const inbound = path.join(base, sess.name, 'inbound.db');
    if (!fs.existsSync(inbound)) continue;
    const mtime = fs.statSync(inbound).mtimeMs;
    if (!newest || mtime > newest.mtime) {
      newest = { path: inbound, mtime };
    }
  }
  return newest?.path ?? null;
}

/**
 * Stage a host-resolved copy of the group's agent dir so buildSystemPrompt
 * can flatten @-imports (container symlinks are dangling on the host).
 */
function stageAgentDir(groupDir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-measure-prompt-'));
  const agentDir = path.join(tmp, 'agent');
  const fragmentsDir = path.join(agentDir, '.agents-fragments');
  fs.mkdirSync(fragmentsDir, { recursive: true });

  const sharedLink = path.join(groupDir, '.agents-shared.md');
  try {
    if (fs.lstatSync(sharedLink).isSymbolicLink()) {
      const host = resolveContainerPathToHost(fs.readlinkSync(sharedLink));
      if (host && fs.existsSync(host)) {
        fs.copyFileSync(host, path.join(agentDir, '.agents-shared.md'));
      }
    }
  } catch {
    /* no symlink */
  }
  if (!fs.existsSync(path.join(agentDir, '.agents-shared.md')) && fs.existsSync(SHARED_AGENTS_MD)) {
    fs.copyFileSync(SHARED_AGENTS_MD, path.join(agentDir, '.agents-shared.md'));
  }

  const composed = resolveComposedPath(groupDir);
  if (composed) {
    fs.copyFileSync(composed, path.join(agentDir, 'AGENTS.md'));
  }

  const local = resolveLocalPath(groupDir);
  if (local) {
    fs.copyFileSync(local, path.join(agentDir, 'AGENTS.local.md'));
  }

  const hostFragments = path.join(groupDir, '.agents-fragments');
  if (fs.existsSync(hostFragments)) {
    for (const name of fs.readdirSync(hostFragments)) {
      const hostTarget = resolveFragmentHostPath(groupDir, name);
      if (hostTarget && fs.existsSync(hostTarget)) {
        fs.copyFileSync(hostTarget, path.join(fragmentsDir, name));
      }
    }
  }

  return tmp;
}

/** PATH for host-side probes (launchd omits ~/.bun/bin and nvm). */
function probeSubprocessEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? os.homedir();
  const prepend = [path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), path.dirname(process.execPath)];
  const existing = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...prepend, ...existing].filter((segment, i, arr) => arr.indexOf(segment) === i);
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

function resolveBunBin(): string {
  const home = process.env.HOME ?? os.homedir();
  const candidates = [process.env.BUN_BIN, path.join(home, '.bun', 'bin', 'bun'), '/usr/local/bin/bun', 'bun'].filter(
    (c): c is string => Boolean(c),
  );

  const env = probeSubprocessEnv();
  for (const bin of candidates) {
    try {
      if (bin !== 'bun' && !fs.existsSync(bin)) continue;
      execFileSync(bin, ['--version'], { stdio: 'ignore', env });
      return bin;
    } catch {
      continue;
    }
  }

  throw new Error('Bun is required to measure MCP tools (install from https://bun.sh)');
}

function writeTempContainerJson(config: object): { path: string; cleanup: () => void } {
  const tmp = path.join(os.tmpdir(), `luna-measure-container-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  return {
    path: tmp,
    cleanup: () => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
    },
  };
}

function probeToolSchemas(group: AgentGroup): ToolProbeResult {
  const bunBin = resolveBunBin();
  const env = probeSubprocessEnv();

  const { path: probePath, cleanup } = writeTempContainerJson(containerConfigForToolProbe(group));
  try {
    const stdout = execFileSync(bunBin, [DUMP_TOOL_SCHEMAS, probePath], {
      cwd: path.join(PROJECT_ROOT, 'container', 'agent-runner'),
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      env,
    });

    const line = stdout.trim().split('\n').pop();
    if (!line) throw new Error('dump-tool-schemas produced no output');
    return JSON.parse(line) as ToolProbeResult;
  } finally {
    cleanup();
  }
}

export async function measureAgent(opts: MeasureOptions): Promise<MeasureResult> {
  const agentDir = path.resolve(getAgentDir());
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent workspace not found: ${agentDir}`);
  }

  ensureDb();

  const agentGroup = getTheAgent();
  composeAgentsMd(agentGroup);

  const stored = readStoredContainerConfig(agentGroup);
  const containerJson: ContainerJson = {
    skills: stored.skills,
    skillsDisabled: stored.skillsDisabled,
    skillsEnabled: stored.skillsEnabled,
    mcpServers: stored.mcpServers,
  };
  const categories: CategoryRow[] = [];
  const composedPath = resolveComposedPath(agentDir);
  const imports = composedPath ? parseComposedImports(composedPath) : [];

  for (const rel of imports) {
    let hostPath: string | null = null;
    let displayPath = '';

    if (rel === './.agents-shared.md' || rel.endsWith('.agents-shared.md')) {
      hostPath = SHARED_AGENTS_MD;
      displayPath = 'container/AGENTS.md';
    } else if (rel.startsWith('./.agents-fragments/')) {
      hostPath = resolveFragmentHostPath(agentDir, path.basename(rel));
      if (hostPath) displayPath = path.relative(PROJECT_ROOT, hostPath);
    }

    if (!hostPath || !fs.existsSync(hostPath)) continue;

    const { category, name } = categoryForFragment(rel);
    categories.push({
      category,
      name,
      chars: charCount(hostPath),
      path: displayPath,
    });
  }

  const localPath = resolveLocalPath(agentDir);
  if (localPath) {
    categories.push({
      category: 'agents_local',
      name: 'AGENTS.local.md',
      chars: charCount(localPath),
      path: path.relative(PROJECT_ROOT, localPath),
    });
  }

  let runtimeChars = 0;
  let runtimeSource: string | undefined;
  let addendum = '';

  if (!opts.noRuntime) {
    let inbound = opts.inbound;
    if (opts.useSession) {
      const agId = agentGroup.id;
      inbound = findSessionInbound(agId) ?? undefined;
      if (!inbound) {
        throw new Error(`No session inbound.db found under data/sessions/${agId}/`);
      }
      runtimeSource = path.relative(PROJECT_ROOT, inbound);
    } else if (inbound) {
      runtimeSource = path.relative(PROJECT_ROOT, inbound);
    }

    const destinations = inbound ? loadDestinations(inbound) : [];
    const assistantName = containerJson.assistantName;
    addendum = buildRuntimeAddendum(assistantName, destinations);
    runtimeChars = addendum.length;

    categories.unshift({
      category: 'runtime',
      name: inbound ? 'identity + destinations (live)' : 'identity + destinations (empty)',
      chars: runtimeChars,
      path: runtimeSource ?? '(no --inbound; destinations table empty)',
    });
  }

  const enabledSkills = resolveEnabledContainerSkills(containerJson);
  const staged = stageAgentDir(agentDir);
  try {
    const stagedAgentDir = path.join(staged, 'agent');
    const skillsHome = path.join(staged, 'home');
    stageSkillsHome(skillsHome, enabledSkills);
    const { buildSystemPrompt, discoverSkills, formatSkillCatalog } = await loadOpenAiProviderModules();
    const skills = discoverSkills(skillsHome);
    const catalogBlock = formatSkillCatalog(skills);
    const full = buildSystemPrompt(addendum || undefined, stagedAgentDir, SHARED_AGENTS_MD, skillsHome);
    const sectionCount = full.split(PROMPT_SECTION_SEP).length;

    let instructionsChars = full.length;
    if (catalogBlock) {
      const idx = full.lastIndexOf(catalogBlock);
      if (idx >= 0) {
        instructionsChars = idx > 0 ? idx - PROMPT_SECTION_SEP.length : 0;
      }
    }
    const skillCatalogBlockChars = full.length - instructionsChars;

    const sumInstructionChars = categories.reduce((n, c) => n + c.chars, 0);

    let tools: MeasureResult['tools'];
    if (opts.noMcp) {
      tools = { skipped: true, reason: '--no-mcp' };
    } else {
      try {
        tools = probeToolSchemas(agentGroup);
      } catch (err) {
        tools = {
          skipped: true,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const toolChars = 'grandTotalChars' in tools ? tools.grandTotalChars : 0;
    const skillCatalog = await measureSkillCatalog(skillsHome);

    return {
      providerNote:
        'Turn 1 ≈ instructions + skill catalog + tool schemas per request. Skill bodies load on invoke via the Skill tool — not counted here.',
      categories,
      runtimeAddendum: {
        included: !opts.noRuntime,
        chars: runtimeChars,
        source: runtimeSource,
      },
      instructions: { chars: instructionsChars },
      skillCatalogBlock: { chars: skillCatalogBlockChars },
      systemPrompt: { chars: full.length, sections: sectionCount },
      skillCatalog,
      tools,
      contextTotal: full.length + toolChars,
      sumInstructionChars,
    };
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

export function formatMeasureHuman(result: MeasureResult, showTokens: boolean): string {
  const lines: string[] = [];
  const tok = (n: number) => (showTokens ? `  (~${Math.round(n / 4)} tok)` : '');

  lines.push('Context breakdown — agent/\n');
  lines.push(result.providerNote + '\n');

  const colName = 22;
  const colChars = 8;

  lines.push('## System instructions\n');
  lines.push(`${'Category'.padEnd(10)} ${'Name'.padEnd(colName)} ${'Chars'.padStart(colChars)}`);
  lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));

  for (const row of result.categories) {
    lines.push(
      `${row.category.padEnd(10)} ${row.name.padEnd(colName).slice(0, colName)} ${String(row.chars).padStart(colChars)}${tok(row.chars)}`,
    );
    lines.push(`           ${row.path}`);
  }

  lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));
  lines.push(
    `${'SUBTOTAL'.padEnd(10)} ${'(instructions)'.padEnd(colName)} ${String(result.instructions.chars).padStart(colChars)}${tok(result.instructions.chars)}`,
  );
  lines.push(
    `           Sum of instruction files: ${result.sumInstructionChars}${tok(result.sumInstructionChars)} — may differ when imports dedupe.`,
  );

  if (result.skillCatalog.length > 0) {
    lines.push('\n## Skill catalog (in system message)\n');
    lines.push(
      'Enabled via container.json → ~/.agents/skills/. Name + description only — full SKILL.md bodies load on invoke via the Skill tool.\n',
    );
    lines.push(`${'Skill'.padEnd(10)} ${'Name'.padEnd(colName)} ${'Chars'.padStart(colChars)}`);
    lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));
    for (const row of result.skillCatalog) {
      lines.push(
        `${row.category.padEnd(10)} ${row.name.padEnd(colName).slice(0, colName)} ${String(row.chars).padStart(colChars)}${tok(row.chars)}`,
      );
      lines.push(`           ${row.path}`);
    }
    lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));
    lines.push(
      `${'SUBTOTAL'.padEnd(10)} ${'(catalog block)'.padEnd(colName)} ${String(result.skillCatalogBlock.chars).padStart(colChars)}${tok(result.skillCatalogBlock.chars)}`,
    );
    if (result.skillCatalog.length > 0) {
      const lineTotal = result.skillCatalog.reduce((n, r) => n + r.chars, 0);
      lines.push(
        `           Per-skill lines: ${lineTotal}${tok(lineTotal)}; remainder is header, framing, and section separator.`,
      );
    }
  }

  lines.push('\n## Tool definitions (per request)\n');

  if ('skipped' in result.tools) {
    lines.push(`(skipped: ${result.tools.reason})\n`);
  } else {
    const { builtin, mcp } = result.tools;
    lines.push(`${'Server'.padEnd(10)} ${'Tool'.padEnd(colName)} ${'Chars'.padStart(colChars)}`);
    lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));

    for (const t of builtin.tools) {
      lines.push(
        `${'builtin'.padEnd(10)} ${t.tool.padEnd(colName).slice(0, colName)} ${String(t.chars).padStart(colChars)}${tok(t.chars)}`,
      );
    }
    lines.push(
      `${'SUBTOTAL'.padEnd(10)} ${'builtin'.padEnd(colName)} ${String(builtin.totalChars).padStart(colChars)}${tok(builtin.totalChars)}`,
    );

    for (const [serverName, server] of Object.entries(mcp.servers)) {
      lines.push('');
      if (server.error && server.tools.length === 0) {
        lines.push(`# ${serverName}: ${server.error}`);
        continue;
      }
      for (const t of server.tools) {
        lines.push(
          `${serverName.padEnd(10)} ${t.tool.padEnd(colName).slice(0, colName)} ${String(t.chars).padStart(colChars)}${tok(t.chars)}`,
        );
      }
      const suffix = server.error ? ` (${server.error})` : '';
      lines.push(
        `${'SUBTOTAL'.padEnd(10)} ${serverName.padEnd(colName)} ${String(server.totalChars).padStart(colChars)}${tok(server.totalChars)}${suffix}`,
      );
    }

    lines.push('-'.repeat(10 + 1 + colName + 1 + colChars));
    lines.push(
      `${'SUBTOTAL'.padEnd(10)} ${'(all MCP + builtin)'.padEnd(colName)} ${String(result.tools.grandTotalChars).padStart(colChars)}${tok(result.tools.grandTotalChars)}`,
    );
  }

  const toolChars = 'grandTotalChars' in result.tools ? result.tools.grandTotalChars : 0;
  const skillCatalogChars = result.skillCatalogBlock.chars;
  lines.push('\n## Combined (turn 1)\n');
  lines.push(`  instructions:    ${result.instructions.chars}${tok(result.instructions.chars)}`);
  if (skillCatalogChars > 0) {
    lines.push(`  skill catalog:   ${skillCatalogChars}${tok(skillCatalogChars)}`);
  }
  lines.push(`  tool schemas:    ${toolChars}${tok(toolChars)}`);
  lines.push(`  TOTAL:           ${result.contextTotal}${tok(result.contextTotal)}`);

  if (!result.runtimeAddendum.included) {
    lines.push('\n(Runtime addendum omitted; use --inbound or --session for live destinations.)');
  } else if (!result.runtimeAddendum.source) {
    lines.push('\n(Runtime destinations: pass --inbound or --session for the live destination map.)');
  }

  return lines.join('\n');
}

/** CLI / script entry: measure the install agent and return or print results. */
export async function runSystemPromptStats(opts: MeasureOptions): Promise<MeasureResult | string> {
  const result = await measureAgent(opts);
  if (opts.json) return result;
  return formatMeasureHuman(result, opts.tokens);
}

async function main(): Promise<void> {
  const opts = parseMeasureArgs(process.argv.slice(2));

  try {
    const out = await runSystemPromptStats(opts);
    if (typeof out === 'string') {
      console.log(out);
    } else {
      console.log(JSON.stringify(out, null, 2));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isMain =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  void main();
}
