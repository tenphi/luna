import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { manageSkill } from './skills.js';

let workspaceRoot: string;
let builtinRoot: string;
let prevWorkspace: string | undefined;
let prevBuiltin: string | undefined;

function textOf(result: { content: { text: string }[]; isError?: boolean }): string {
  return result.content.map((c) => c.text).join('\n');
}

async function call(args: Record<string, unknown>) {
  return (await manageSkill.handler(args)) as { content: { text: string }[]; isError?: boolean };
}

function skillFile(name: string): string {
  return path.join(workspaceRoot, name, 'SKILL.md');
}

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-skill-ws-'));
  builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-skill-builtin-'));
  prevWorkspace = process.env.LUNA_AGENT_SKILLS_PATH;
  prevBuiltin = process.env.LUNA_BUILTIN_SKILLS_PATH;
  process.env.LUNA_AGENT_SKILLS_PATH = workspaceRoot;
  process.env.LUNA_BUILTIN_SKILLS_PATH = builtinRoot;
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(builtinRoot, { recursive: true, force: true });
  if (prevWorkspace === undefined) delete process.env.LUNA_AGENT_SKILLS_PATH;
  else process.env.LUNA_AGENT_SKILLS_PATH = prevWorkspace;
  if (prevBuiltin === undefined) delete process.env.LUNA_BUILTIN_SKILLS_PATH;
  else process.env.LUNA_BUILTIN_SKILLS_PATH = prevBuiltin;
});

describe('manage_skill create', () => {
  it('creates a skill with frontmatter and body', async () => {
    const res = await call({ action: 'create', name: 'weekly-report', description: 'Compile the report', body: '1. Do it' });
    expect(res.isError).toBeFalsy();
    const content = fs.readFileSync(skillFile('weekly-report'), 'utf-8');
    expect(content).toContain('name: weekly-report');
    expect(content).toContain('description: Compile the report');
    expect(content).toContain('1. Do it');
  });

  it('requires description and body on create', async () => {
    expect((await call({ action: 'create', name: 'x', body: 'b' })).isError).toBe(true);
    expect((await call({ action: 'create', name: 'x', description: 'd' })).isError).toBe(true);
  });

  it('rejects invalid names', async () => {
    const res = await call({ action: 'create', name: 'Bad Name', description: 'd', body: 'b' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Invalid');
  });

  it('rejects names that collide with a built-in skill', async () => {
    fs.mkdirSync(path.join(builtinRoot, 'email'), { recursive: true });
    const res = await call({ action: 'create', name: 'email', description: 'd', body: 'b' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('built-in');
  });

  it('refuses to create over an existing skill', async () => {
    await call({ action: 'create', name: 'dup', description: 'd', body: 'b' });
    const res = await call({ action: 'create', name: 'dup', description: 'd2', body: 'b2' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('already exists');
  });

  it('enforces a body size cap', async () => {
    const big = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    const res = await call({ action: 'create', name: 'big', description: 'd', body: big });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('max');
  });

  it('writes bundled files and rejects traversal / SKILL.md', async () => {
    const ok = await call({
      action: 'create',
      name: 'withfiles',
      description: 'd',
      body: 'b',
      files: { 'helper.py': 'print(1)' },
    });
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(workspaceRoot, 'withfiles', 'helper.py'), 'utf-8')).toBe('print(1)');

    const traversal = await call({
      action: 'create',
      name: 'evil',
      description: 'd',
      body: 'b',
      files: { '../escape.txt': 'x' },
    });
    expect(traversal.isError).toBe(true);

    const overwrite = await call({
      action: 'create',
      name: 'evil2',
      description: 'd',
      body: 'b',
      files: { 'SKILL.md': 'x' },
    });
    expect(overwrite.isError).toBe(true);
  });
});

describe('manage_skill update', () => {
  it('updates description while keeping the body', async () => {
    await call({ action: 'create', name: 'note', description: 'old', body: 'keep me' });
    const res = await call({ action: 'update', name: 'note', description: 'new' });
    expect(res.isError).toBeFalsy();
    const content = fs.readFileSync(skillFile('note'), 'utf-8');
    expect(content).toContain('description: new');
    expect(content).toContain('keep me');
  });

  it('updates the body while keeping the description', async () => {
    await call({ action: 'create', name: 'note', description: 'keep desc', body: 'old body' });
    await call({ action: 'update', name: 'note', body: 'new body' });
    const content = fs.readFileSync(skillFile('note'), 'utf-8');
    expect(content).toContain('description: keep desc');
    expect(content).toContain('new body');
    expect(content).not.toContain('old body');
  });

  it('preserves extra frontmatter keys on update', async () => {
    const dir = path.join(workspaceRoot, 'garden-monthly-review');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: garden-review\ndescription: Monthly review\nrequires_mcp: vulpine\n---\n\nOld steps\n',
    );
    const res = await call({ action: 'update', name: 'garden-review', body: 'New steps' });
    expect(res.isError).toBeFalsy();
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('name: garden-review');
    expect(content).toContain('requires_mcp: vulpine');
    expect(content).toContain('New steps');
    expect(content).not.toContain('Old steps');
  });

  it('fails to update a nonexistent skill', async () => {
    const res = await call({ action: 'update', name: 'ghost', description: 'x' });
    expect(res.isError).toBe(true);
  });

  it('requires at least one field to update', async () => {
    await call({ action: 'create', name: 'note', description: 'd', body: 'b' });
    const res = await call({ action: 'update', name: 'note' });
    expect(res.isError).toBe(true);
  });
});

describe('manage_skill catalog name vs folder name', () => {
  function writeMismatchedSkill() {
    const dir = path.join(workspaceRoot, 'garden-monthly-review');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: garden-review\ndescription: Monthly garden review\nrequires_mcp: vulpine\n---\n\nDo the review.\n',
    );
    return dir;
  }

  it('lists by frontmatter catalog name, not folder name', async () => {
    writeMismatchedSkill();
    const text = textOf(await call({ action: 'list' }));
    expect(text).toContain('garden-review — Monthly garden review');
    expect(text).not.toContain('garden-monthly-review');
  });

  it('reads / updates / deletes by catalog name when folder differs', async () => {
    const dir = writeMismatchedSkill();

    const read = await call({ action: 'read', name: 'garden-review' });
    expect(read.isError).toBeFalsy();
    expect(textOf(read)).toContain('Do the review.');

    const update = await call({ action: 'update', name: 'garden-review', description: 'Updated desc' });
    expect(update.isError).toBeFalsy();
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('description: Updated desc');
    expect(content).toContain('requires_mcp: vulpine');
    expect(fs.existsSync(skillFile('garden-review'))).toBe(false);

    const del = await call({ action: 'delete', name: 'garden-review' });
    expect(del.isError).toBeFalsy();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('rejects create when catalog name already exists under a different folder', async () => {
    writeMismatchedSkill();
    const res = await call({
      action: 'create',
      name: 'garden-review',
      description: 'dup',
      body: 'should fail',
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('already exists');
    expect(fs.existsSync(skillFile('garden-review'))).toBe(false);
  });
});

describe('manage_skill delete / list / read', () => {
  it('deletes an authored skill', async () => {
    await call({ action: 'create', name: 'temp', description: 'd', body: 'b' });
    const res = await call({ action: 'delete', name: 'temp' });
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(path.join(workspaceRoot, 'temp'))).toBe(false);
  });

  it('fails to delete a nonexistent skill', async () => {
    expect((await call({ action: 'delete', name: 'ghost' })).isError).toBe(true);
  });

  it('lists authored skills', async () => {
    await call({ action: 'create', name: 'a-skill', description: 'Alpha', body: 'b' });
    await call({ action: 'create', name: 'b-skill', description: 'Beta', body: 'b' });
    const res = await call({ action: 'list' });
    const text = textOf(res);
    expect(text).toContain('a-skill — Alpha');
    expect(text).toContain('b-skill — Beta');
  });

  it('reads an authored skill with bundled files', async () => {
    await call({ action: 'create', name: 'readable', description: 'd', body: 'the steps', files: { 'ref.md': '#' } });
    const res = await call({ action: 'read', name: 'readable' });
    const text = textOf(res);
    expect(text).toContain('the steps');
    expect(text).toContain('ref.md');
  });

  it('rejects unknown actions', async () => {
    const res = await call({ action: 'frobnicate' });
    expect(res.isError).toBe(true);
  });
});
