import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { builtinToolSchemas, callBuiltinTool, isBuiltinTool } from './builtin.js';
import { installTestSessionClient, resetTestSessionClient } from '../../../session/test-support.js';

let tmp: string;

beforeEach(() => {
  // Bash/tool runs signal in-flight state via liveness pings; install an
  // in-memory client so those fire-and-forget pings have somewhere to land.
  installTestSessionClient();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-builtin-'));
});

afterEach(() => {
  resetTestSessionClient();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('builtin tool schemas', () => {
  it('exposes the core tool surface', () => {
    const names = builtinToolSchemas()
      .map((t) => t.function.name)
      .sort();
    expect(names).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'Write']);
  });

  it('isBuiltinTool recognizes built-ins and rejects others', () => {
    expect(isBuiltinTool('Bash')).toBe(true);
    expect(isBuiltinTool('mcp__luna__send_message')).toBe(false);
  });
});

describe('Write + Read + Edit', () => {
  it('writes a file then reads it back with line numbers', async () => {
    const file = path.join(tmp, 'note.txt');
    const wrote = await callBuiltinTool('Write', { file_path: file, contents: 'hello\nworld' });
    expect(wrote).toContain('Wrote');
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello\nworld');

    const read = await callBuiltinTool('Read', { file_path: file });
    expect(read).toContain('File: note.txt');
    expect(read).toContain('hello');
    expect(read).toContain('world');
    expect(read).toMatch(/\s+1\|hello/);
  });

  it('edits an exact string', async () => {
    const file = path.join(tmp, 'edit.txt');
    fs.writeFileSync(file, 'foo bar baz');
    const res = await callBuiltinTool('Edit', { file_path: file, old_string: 'bar', new_string: 'QUX' });
    expect(res).toContain('Edited');
    expect(fs.readFileSync(file, 'utf-8')).toBe('foo QUX baz');
  });

  it('refuses an ambiguous edit without replace_all', async () => {
    const file = path.join(tmp, 'amb.txt');
    fs.writeFileSync(file, 'x x x');
    const res = await callBuiltinTool('Edit', { file_path: file, old_string: 'x', new_string: 'y' });
    expect(res).toContain('occurs 3 times');
    expect(fs.readFileSync(file, 'utf-8')).toBe('x x x');
  });

  it('replace_all replaces every occurrence', async () => {
    const file = path.join(tmp, 'all.txt');
    fs.writeFileSync(file, 'x x x');
    const res = await callBuiltinTool('Edit', { file_path: file, old_string: 'x', new_string: 'y', replace_all: true });
    expect(res).toContain('3 replacements');
    expect(fs.readFileSync(file, 'utf-8')).toBe('y y y');
  });
});

describe('Bash', () => {
  it('runs a command and returns stdout', async () => {
    const res = await callBuiltinTool('Bash', { command: 'echo hi-from-bash' });
    expect(res).toContain('hi-from-bash');
  });

  it('reports a non-zero exit code', async () => {
    const res = await callBuiltinTool('Bash', { command: 'exit 3' });
    expect(res).toContain('exit code 3');
  });

  it('aborts a long-running Bash via AbortSignal', async () => {
    const ac = new AbortController();
    const promise = callBuiltinTool('Bash', { command: 'sleep 30', timeout: 60_000 }, ac.signal);
    await Bun.sleep(100);
    ac.abort();
    const res = await promise;
    expect(res).toContain('[aborted]');
  });
});

describe('Glob + Grep', () => {
  it('Glob finds files by pattern', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'b.js'), '');
    const res = await callBuiltinTool('Glob', { pattern: '*.ts', path: tmp });
    expect(res).toContain('a.ts');
    expect(res).not.toContain('b.js');
  });

  it('Grep finds matching lines', async () => {
    fs.writeFileSync(path.join(tmp, 'src.txt'), 'alpha\nbeta TARGET\ngamma');
    const res = await callBuiltinTool('Grep', { pattern: 'TARGET', path: tmp });
    expect(res).toContain('TARGET');
    expect(res).toContain(':2:');
  });
});

/**
 * The refusal is agent-facing, so it asserts the *absence* of the backend name:
 * the agent is told the knowledge base is off-limits to filesystem tools and
 * which memory tools to use instead, never what the store is called.
 */
describe('knowledge-base hard block', () => {
  let memory: string;
  let prevMemory: string | undefined;

  beforeEach(() => {
    memory = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-memory-'));
    fs.mkdirSync(path.join(memory, 'people'), { recursive: true });
    fs.writeFileSync(path.join(memory, 'people', 'jane.md'), 'jane page');
    prevMemory = process.env.LUNA_MEMORY_PATH;
    process.env.LUNA_MEMORY_PATH = memory;
  });

  afterEach(() => {
    if (prevMemory === undefined) delete process.env.LUNA_MEMORY_PATH;
    else process.env.LUNA_MEMORY_PATH = prevMemory;
    fs.rmSync(memory, { recursive: true, force: true });
  });

  it('blocks Read/Write/Edit/Glob/Grep on the memory path', async () => {
    const page = path.join(memory, 'people', 'jane.md');

    const read = await callBuiltinTool('Read', { file_path: page });
    expect(read).toContain('knowledge base');
    expect(read).toContain('not reachable with filesystem tools');
    expect(read).toContain('memory_read');

    const write = await callBuiltinTool('Write', { file_path: page, contents: 'tampered' });
    expect(write).toContain('knowledge base');
    expect(fs.readFileSync(page, 'utf-8')).toBe('jane page');

    const edit = await callBuiltinTool('Edit', { file_path: page, old_string: 'jane', new_string: 'X' });
    expect(edit).toContain('knowledge base');
    expect(fs.readFileSync(page, 'utf-8')).toBe('jane page');

    const glob = await callBuiltinTool('Glob', { pattern: '**/*.md', path: memory });
    expect(glob).toContain('knowledge base');

    const grep = await callBuiltinTool('Grep', { pattern: 'jane', path: memory });
    expect(grep).toContain('knowledge base');
  });

  it('blocks Bash commands that reference the memory path', async () => {
    const res = await callBuiltinTool('Bash', { command: `cat ${memory}/people/jane.md` });
    expect(res).toContain('knowledge base');
    expect(res).not.toContain('jane page');
  });

  it('still blocks stored binaries, and points at the memory tools', async () => {
    const photo = path.join(memory, 'people', 'jane.jpg');
    fs.writeFileSync(photo, 'jpegbytes');

    const read = await callBuiltinTool('Read', { file_path: photo });
    expect(read).toContain('memory_read');
    expect(read).toContain('memory_ingest');

    const bash = await callBuiltinTool('Bash', { command: `cp /tmp/x.jpg ${photo}` });
    expect(bash).toContain('memory_ingest');
    expect(fs.readFileSync(photo, 'utf-8')).toBe('jpegbytes');
  });

  it('still allows tools outside the memory path', async () => {
    const file = path.join(tmp, 'ok.txt');
    const wrote = await callBuiltinTool('Write', { file_path: file, contents: 'fine' });
    expect(wrote).toContain('Wrote');
    const bash = await callBuiltinTool('Bash', { command: 'echo allowed' });
    expect(bash).toContain('allowed');
  });
});

describe('Skill', () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
    const dir = path.join(tmp, '.agents', 'skills', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: demo\ndescription: A demo skill\n---\n\nDetailed demo instructions here.',
    );
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it('lists available skills when called with no name', async () => {
    const res = await callBuiltinTool('Skill', {});
    expect(res).toContain('demo');
    expect(res).toContain('A demo skill');
  });

  it('loads the full instructions for a named skill', async () => {
    const res = await callBuiltinTool('Skill', { name: 'demo' });
    expect(res).toContain('Detailed demo instructions here.');
  });

  it('reports unknown skill names', async () => {
    const res = await callBuiltinTool('Skill', { name: 'nope' });
    expect(res).toContain('not found');
    expect(res).toContain('demo');
  });
});
