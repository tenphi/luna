import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  discoverSkills,
  formatSkillCatalog,
  formatSkillMcpPrerequisiteError,
  loadSkill,
  requiredMcpServersFromSkill,
} from './skills.js';

let home: string;
let skillsDir: string;

function writeSkill(name: string, frontmatter: string, body = 'Body for ' + name): string {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-skills-home-'));
  skillsDir = path.join(home, '.agents', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('discoverSkills', () => {
  it('returns [] when no skills dir exists', () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    expect(discoverSkills(home)).toEqual([]);
  });

  it('parses name and description from frontmatter, sorted by name', () => {
    writeSkill('zeta', 'name: zeta\ndescription: Last one');
    writeSkill('alpha', 'name: alpha\ndescription: First one');
    const skills = discoverSkills(home);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
    expect(skills[0].description).toBe('First one');
    expect(skills[1].description).toBe('Last one');
  });

  it('strips surrounding quotes from frontmatter values', () => {
    writeSkill('quoted', 'name: "quoted"\ndescription: "A quoted description"');
    const skills = discoverSkills(home);
    expect(skills[0].name).toBe('quoted');
    expect(skills[0].description).toBe('A quoted description');
  });

  it('folds block-scalar descriptions instead of exposing the YAML indicator', () => {
    writeSkill(
      'folded',
      ['name: folded', 'description: >-', '  First line of the description', '  and its continuation.', 'author: x'].join(
        '\n',
      ),
    );
    const skills = discoverSkills(home);
    expect(skills[0].description).toBe('First line of the description and its continuation.');
  });

  it('falls back to the directory name when frontmatter has no name', () => {
    const dir = path.join(skillsDir, 'no-name');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'no frontmatter here');
    const skills = discoverSkills(home);
    expect(skills[0].name).toBe('no-name');
    expect(skills[0].description).toBe('');
  });

  it('skips entries without a SKILL.md', () => {
    fs.mkdirSync(path.join(skillsDir, 'empty'), { recursive: true });
    writeSkill('real', 'name: real\ndescription: has a skill file');
    const skills = discoverSkills(home);
    expect(skills.map((s) => s.name)).toEqual(['real']);
  });

  it('discovers SKILL.md when instructions.md also exists in the same dir', () => {
    const dir = writeSkill('dual', 'name: dual\ndescription: Both files present');
    fs.writeFileSync(path.join(dir, 'instructions.md'), '# Always-on fragment\n');
    const skills = discoverSkills(home);
    expect(skills.map((s) => s.name)).toEqual(['dual']);
    expect(loadSkill('dual', home)!.content).toContain('Both files present');
  });

  it('follows symlinks to the shared skills mount', () => {
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-skills-shared-'));
    const target = path.join(sharedRoot, 'linked');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: linked\ndescription: Via symlink\n---\n\nBody');
    fs.symlinkSync(target, path.join(skillsDir, 'linked'));
    const skills = discoverSkills(home);
    expect(skills.map((s) => s.name)).toEqual(['linked']);
    fs.rmSync(sharedRoot, { recursive: true, force: true });
  });

  it('tags built-in skills with source: builtin', () => {
    writeSkill('builtin-one', 'name: builtin-one\ndescription: Shipped');
    const skills = discoverSkills(home, path.join(home, 'nonexistent-workspace'));
    expect(skills[0].source).toBe('builtin');
  });
});

describe('discoverSkills — workspace merge', () => {
  let workspaceRoot: string;

  function writeWorkspaceSkill(name: string, description: string): void {
    const dir = path.join(workspaceRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`);
  }

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-skills-ws-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('merges built-in and workspace skills, sorted by name', () => {
    writeSkill('builtin-b', 'name: builtin-b\ndescription: Built-in B');
    writeWorkspaceSkill('authored-a', 'Authored A');
    const skills = discoverSkills(home, workspaceRoot);
    expect(skills.map((s) => s.name)).toEqual(['authored-a', 'builtin-b']);
    expect(skills.find((s) => s.name === 'authored-a')!.source).toBe('workspace');
    expect(skills.find((s) => s.name === 'builtin-b')!.source).toBe('builtin');
  });

  it('built-in wins on a name collision (workspace cannot shadow)', () => {
    writeSkill('shared', 'name: shared\ndescription: The built-in one');
    writeWorkspaceSkill('shared', 'The authored one');
    const skills = discoverSkills(home, workspaceRoot);
    const shared = skills.filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe('builtin');
    expect(shared[0].description).toBe('The built-in one');
  });

  it('loadSkill can load an authored workspace skill', () => {
    writeWorkspaceSkill('authored', 'Authored skill');
    const loaded = loadSkill('authored', home, workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toContain('Authored skill');
  });
});

describe('formatSkillCatalog', () => {
  it('returns empty string with no skills', () => {
    expect(formatSkillCatalog([])).toBe('');
  });

  it('lists each skill and mentions the Skill tool', () => {
    writeSkill('foo', 'name: foo\ndescription: Does foo things');
    const catalog = formatSkillCatalog(discoverSkills(home));
    expect(catalog).toContain('# Skills');
    expect(catalog).toContain('**foo** — Does foo things');
    expect(catalog).toContain('`Skill`');
  });
});

describe('loadSkill', () => {
  it('returns full content and bundled files for an existing skill', () => {
    const dir = writeSkill('bundled', 'name: bundled\ndescription: has extras', 'The detailed steps');
    fs.writeFileSync(path.join(dir, 'helper.py'), 'print(1)');
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'templates', 'a.txt'), 'x');

    const loaded = loadSkill('bundled', home);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toContain('The detailed steps');
    expect(loaded!.files).toEqual(['helper.py', path.join('templates', 'a.txt')]);
  });

  it('returns null for an unknown skill', () => {
    writeSkill('known', 'name: known\ndescription: real');
    expect(loadSkill('missing', home)).toBeNull();
  });
});

describe('requiredMcpServersFromSkill', () => {
  it('reads requires_mcp from frontmatter', () => {
    const content = `---
name: bank-review
description: x
requires_mcp: vulpine, email
---

Body`;
    expect(requiredMcpServersFromSkill(content)).toEqual(['email', 'vulpine']);
  });

  it('infers servers from mcp__server__ references in the body', () => {
    const content = `---
name: demo
description: x
---

Call mcp__vulpine__cashflow and mcp__vulpine__transactions.
`;
    expect(requiredMcpServersFromSkill(content)).toEqual(['vulpine']);
  });

  it('merges frontmatter and body refs without duplicates', () => {
    const content = `---
name: demo
description: x
requires_mcp: vulpine
---

Also mcp__apple_calendar__list_events.
`;
    expect(requiredMcpServersFromSkill(content)).toEqual(['apple_calendar', 'vulpine']);
  });
});

describe('formatSkillMcpPrerequisiteError', () => {
  it('tells the model to stop and inform the user', () => {
    const msg = formatSkillMcpPrerequisiteError('bank-review', [
      { server: 'vulpine', configured: false, connected: false },
    ]);
    expect(msg.startsWith('Error:')).toBe(true);
    expect(msg).toContain('bank-review');
    expect(msg).toContain('vulpine');
    expect(msg).toContain('not wired');
    expect(msg).toContain('Do not invent data');
  });

  it('includes connect errors when configured but failed', () => {
    const msg = formatSkillMcpPrerequisiteError('demo', [
      {
        server: 'vulpine',
        configured: true,
        connected: false,
        connectError: 'spawn failed',
      },
    ]);
    expect(msg).toContain('failed to connect: spawn failed');
  });
});
