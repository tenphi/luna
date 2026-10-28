/**
 * Built-in tools for the OpenAI provider.
 *
 * The Claude provider gets Bash/Read/Write/Edit/Glob/Grep for free from the
 * Claude Code CLI. A raw OpenAI endpoint only does chat-completions with
 * function calling, so we implement the equivalent surface here and expose
 * each as an OpenAI function tool.
 *
 * In-flight tracking mirrors the Claude PreToolUse/PostToolUse hooks: we
 * record the running tool (and any declared Bash timeout) via a liveness ping
 * so the host sweep can widen its stuck tolerance for long-running commands.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../../../db/connection.js';
import { discoverSkills, loadSkill } from '../skills.js';
import { normalizeEditArg } from './edit-normalize.js';

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolHandler = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;

interface BuiltinTool {
  schema: OpenAITool;
  handler: ToolHandler;
}

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

const AGENT_CWD = '/workspace/agent';

function bashCwd(): string {
  return fs.existsSync(AGENT_CWD) ? AGENT_CWD : process.cwd();
}

/** SIGKILL the process group (detached spawn) or fall back to the child alone. */
function killBashTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (child.pid != null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* group may already be gone; try the child */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already dead */
  }
}

function runBash(command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('[aborted]');
      return;
    }

    const child = spawn('bash', ['-c', command], {
      cwd: bashCwd(),
      env: process.env,
      // Own process group so abort/timeout can SIGKILL the whole tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(clip(text));
    };

    const onAbort = () => {
      killBashTree(child);
      const parts = [stdout, stderr].filter(Boolean).join('');
      settle(parts ? `${parts}\n[aborted]` : '[aborted]');
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killBashTree(child);
      settle(`${stdout}${stderr}\n[command timed out after ${timeoutMs}ms]`);
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      settle(`Failed to run command: ${err.message}`);
    });
    child.on('close', (code) => {
      if (signal?.aborted) {
        const parts = [stdout, stderr].filter(Boolean).join('');
        settle(parts ? `${parts}\n[aborted]` : '[aborted]');
        return;
      }
      const parts = [stdout, stderr].filter(Boolean).join('');
      const suffix = code === 0 ? '' : `\n[exit code ${code}]`;
      settle((parts || '(no output)') + suffix);
    });
  });
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve('/workspace/agent', p);
}

/**
 * Absolute paths the built-in filesystem tools must never touch.
 *
 * The knowledge base is not mounted into the container at all, so in the normal case there is
 * nothing here to block and this is an empty list. It stays because the guard is cheap and the
 * failure it prevents is not: a page edited as a file goes around memory entirely, and the
 * index then disagrees with a file nobody told it about.
 */
function kbBlockedRoots(): string[] {
  const value = process.env.LUNA_MEMORY_PATH;
  return value && value.trim() ? [path.resolve(value.trim())] : [];
}

/** True if `target` is `root` itself or a descendant of it (segment-aware). */
function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Every tool this used to name was removed with the graph store, so the one place that told
// an agent what to do instead was sending it to seven tools that do not exist.
const KB_BLOCKED_MESSAGE =
  'Error: the knowledge base is not reachable with filesystem tools — it is not mounted here. ' +
  'Use the memory tools: memory_recall to search, memory_read to read a page, a fact, or a stored ' +
  "document's full text, memory_write and memory_remember to write claims, memory_retain to preserve " +
  'reference material, memory_ingest to file a new file, ' +
  'and memory_move / memory_forget to relocate or retract.';

/**
 * Return an error string when `resolvedPath` is inside a blocked KB root, else
 * null. Exported so `extract_document` reuses this containment check rather than
 * reimplementing it — one place decides what "inside the memory" means.
 */
export function assertKbBlocked(resolvedPath: string): string | null {
  const target = path.resolve(resolvedPath);
  for (const root of kbBlockedRoots()) {
    if (isWithin(root, target)) return KB_BLOCKED_MESSAGE;
  }
  return null;
}

/** Return an error string when a bash command references a blocked KB root, else null. */
function assertBashKbBlocked(command: string): string | null {
  for (const root of kbBlockedRoots()) {
    if (command.includes(root)) return KB_BLOCKED_MESSAGE;
  }
  return null;
}

function globToRegExp(pattern: string): RegExp {
  // Minimal glob → regex: ** matches across dirs, * within a segment, ? one char.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function walkDir(dir: string, base: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, base, out, limit);
    } else {
      out.push(path.relative(base, full));
    }
  }
}

const TOOLS: Record<string, BuiltinTool> = {
  Bash: {
    schema: {
      type: 'function',
      function: {
        name: 'Bash',
        description:
          'Run a bash command in the agent workspace (/workspace/agent). Returns combined stdout/stderr. Use for git, file inspection, scripts, etc.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute.' },
            timeout: { type: 'number', description: 'Optional timeout in milliseconds (default 120000).' },
          },
          required: ['command'],
        },
      },
    },
    handler: async (args, signal) => {
      const command = String(args.command ?? '');
      if (!command) return 'Error: command is required.';
      const blocked = assertBashKbBlocked(command);
      if (blocked) return blocked;
      const timeoutMs = typeof args.timeout === 'number' ? args.timeout : DEFAULT_BASH_TIMEOUT_MS;
      return runBash(command, timeoutMs, signal);
    },
  },

  Read: {
    schema: {
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file from the filesystem. Returns its contents with 1-indexed line numbers.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute or workspace-relative path to the file.' },
            offset: { type: 'number', description: 'Optional 1-indexed start line.' },
            limit: { type: 'number', description: 'Optional max number of lines to read.' },
          },
          required: ['file_path'],
        },
      },
    },
    handler: async (args) => {
      const file = resolvePath(String(args.file_path ?? ''));
      const blocked = assertKbBlocked(file);
      if (blocked) return blocked;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch (err) {
        return `Error reading ${file}: ${err instanceof Error ? err.message : String(err)}`;
      }
      const lines = content.split('\n');
      const offset = typeof args.offset === 'number' ? Math.max(1, args.offset) : 1;
      const limit = typeof args.limit === 'number' ? args.limit : lines.length;
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${String(offset + i).padStart(6)}|${l}`).join('\n');
      // Keep the source name beside the numbered passage so the model can
      // identify it when several attachments could be confused.
      return clip(`File: ${path.basename(file)}\n${numbered || '(empty file)'}`);
    },
  },

  Write: {
    schema: {
      type: 'function',
      function: {
        name: 'Write',
        description: 'Write (or overwrite) a file with the given contents. Creates parent directories as needed.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute or workspace-relative path to write.' },
            contents: { type: 'string', description: 'The full file contents.' },
          },
          required: ['file_path', 'contents'],
        },
      },
    },
    handler: async (args) => {
      const file = resolvePath(String(args.file_path ?? ''));
      const blocked = assertKbBlocked(file);
      if (blocked) return blocked;
      const contents = String(args.contents ?? '');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        return `Wrote ${contents.length} chars to ${file}`;
      } catch (err) {
        return `Error writing ${file}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  Edit: {
    schema: {
      type: 'function',
      function: {
        name: 'Edit',
        description:
          'Replace an exact string in a file. old_string must be unique unless replace_all is true. Fails if old_string is not found.',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute or workspace-relative path to edit.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences (default false).' },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    handler: async (args) => {
      const file = resolvePath(String(args.file_path ?? ''));
      const blocked = assertKbBlocked(file);
      if (blocked) return blocked;
      const oldRaw = String(args.old_string ?? '');
      const newRaw = String(args.new_string ?? '');
      const replaceAll = args.replace_all === true;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch (err) {
        return `Error reading ${file}: ${err instanceof Error ? err.message : String(err)}`;
      }
      let oldStr = oldRaw;
      let newStr = newRaw;
      let count = content.split(oldStr).length - 1;
      if (count === 0) {
        const unescapedOld = normalizeEditArg(oldRaw);
        if (unescapedOld !== oldRaw) {
          const unescapedCount = content.split(unescapedOld).length - 1;
          if (unescapedCount > 0) {
            oldStr = unescapedOld;
            newStr = normalizeEditArg(newRaw);
            count = unescapedCount;
          }
        }
      } else if (/\\[nrt]/.test(newRaw)) {
        newStr = normalizeEditArg(newRaw);
      }
      if (count === 0) return `Error: old_string not found in ${file}.`;
      if (count > 1 && !replaceAll) {
        return `Error: old_string occurs ${count} times in ${file}. Provide more context or set replace_all.`;
      }
      const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      try {
        fs.writeFileSync(file, updated);
        return `Edited ${file} (${count} replacement${count === 1 ? '' : 's'}).`;
      } catch (err) {
        return `Error writing ${file}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  Glob: {
    schema: {
      type: 'function',
      function: {
        name: 'Glob',
        description: 'Find files matching a glob pattern (supports ** and *). Returns matching paths.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
            path: { type: 'string', description: 'Optional base directory (default /workspace/agent).' },
          },
          required: ['pattern'],
        },
      },
    },
    handler: async (args) => {
      const base = resolvePath(String(args.path ?? '/workspace/agent'));
      const blocked = assertKbBlocked(base);
      if (blocked) return blocked;
      const pattern = String(args.pattern ?? '');
      const re = globToRegExp(pattern.startsWith('**/') ? pattern : `**/${pattern}`);
      const all: string[] = [];
      walkDir(base, base, all, 5000);
      const matches = all.filter((rel) => re.test(rel)).slice(0, 500);
      return matches.length ? matches.join('\n') : '(no matches)';
    },
  },

  Grep: {
    schema: {
      type: 'function',
      function: {
        name: 'Grep',
        description: 'Search file contents for a regex pattern. Returns matching lines with file:line prefixes.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression to search for.' },
            path: { type: 'string', description: 'Optional base directory (default /workspace/agent).' },
            ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false).' },
          },
          required: ['pattern'],
        },
      },
    },
    handler: async (args) => {
      const base = resolvePath(String(args.path ?? '/workspace/agent'));
      const blocked = assertKbBlocked(base);
      if (blocked) return blocked;
      const pattern = String(args.pattern ?? '');
      let re: RegExp;
      try {
        re = new RegExp(pattern, args.ignore_case === true ? 'i' : '');
      } catch (err) {
        return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      }
      const files: string[] = [];
      const stat = (() => {
        try {
          return fs.statSync(base);
        } catch {
          return null;
        }
      })();
      if (stat?.isFile()) {
        files.push(path.relative(base, base) || base);
      } else {
        walkDir(base, base, files, 5000);
      }
      const out: string[] = [];
      for (const rel of files) {
        if (out.length >= 200) break;
        const full = path.isAbsolute(rel) ? rel : path.join(base, rel);
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}:${lines[i]}`);
            if (out.length >= 200) break;
          }
        }
      }
      return out.length ? clip(out.join('\n')) : '(no matches)';
    },
  },

  Skill: {
    schema: {
      type: 'function',
      function: {
        name: 'Skill',
        description:
          'Load the full instructions for one of your available skills. Call this with the skill `name` when a task matches a skill, BEFORE acting, to load its detailed workflow. Omit `name` to list all available skills.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'The name of the skill to load (as shown in the skills catalog). Omit to list available skills.',
            },
          },
        },
      },
    },
    handler: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        const skills = discoverSkills();
        if (skills.length === 0) return 'No skills are available.';
        return (
          'Available skills (call Skill with one of these names to load it):\n' +
          skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')
        );
      }
      const loaded = loadSkill(name);
      if (!loaded) {
        const skills = discoverSkills();
        const names = skills.map((s) => s.name).join(', ') || '(none)';
        return `Skill "${name}" not found. Available skills: ${names}`;
      }
      const header = `# Skill: ${loaded.name}\n\nSkill directory contains these bundled files (read them as needed):\n${
        loaded.files.length ? loaded.files.map((f) => `- ${f}`).join('\n') : '(none)'
      }\n\n---\n\n`;
      return clip(header + loaded.content);
    },
  },
};

/** OpenAI tool schemas for all built-in tools. */
export function builtinToolSchemas(): OpenAITool[] {
  return Object.values(TOOLS).map((t) => t.schema);
}

/** True if `name` is a built-in tool. */
export function isBuiltinTool(name: string): boolean {
  return name in TOOLS;
}

/**
 * Dispatch a built-in tool call, recording it as in-flight for the host
 * sweep (mirrors the Claude PreToolUse/PostToolUse hooks).
 * `signal` cancels in-flight Bash (process-group SIGKILL); other tools ignore it.
 */
export async function callBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `Unknown tool: ${name}`;
  const declaredTimeout = name === 'Bash' && typeof args.timeout === 'number' ? (args.timeout as number) : null;
  try {
    setContainerToolInFlight(name, declaredTimeout);
  } catch {
    /* best-effort */
  }
  try {
    return await tool.handler(args, signal);
  } finally {
    try {
      clearContainerToolInFlight();
    } catch {
      /* best-effort */
    }
  }
}
