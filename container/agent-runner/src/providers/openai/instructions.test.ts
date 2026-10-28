import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildSystemPrompt } from './instructions.js';

let agentDir: string;
let sharedBase: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-instr-agent-'));
  sharedBase = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openai-instr-shared-')), 'AGENTS.md');
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(sharedBase), { recursive: true, force: true });
});

describe('buildSystemPrompt', () => {
  it('prepends the runtime addendum', () => {
    const prompt = buildSystemPrompt('IDENTITY ADDENDUM', agentDir, sharedBase);
    expect(prompt).toContain('IDENTITY ADDENDUM');
  });

  it('flattens @-imports in the composed AGENTS.md', () => {
    fs.writeFileSync(path.join(agentDir, '.agents-shared.md'), 'SHARED BASE CONTENT');
    fs.mkdirSync(path.join(agentDir, '.agents-fragments'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, '.agents-fragments', 'skill-foo.md'), 'FRAGMENT FOO');
    fs.writeFileSync(
      path.join(agentDir, 'AGENTS.md'),
      ['<!-- composed header -->', '@./.agents-shared.md', '@./.agents-fragments/skill-foo.md', ''].join('\n'),
    );

    const prompt = buildSystemPrompt(undefined, agentDir, sharedBase);
    expect(prompt).toContain('SHARED BASE CONTENT');
    expect(prompt).toContain('FRAGMENT FOO');
    expect(prompt).not.toContain('composed header');
    expect(prompt).not.toContain('@./');
  });

  it('appends AGENTS.local.md as per-group memory', () => {
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), 'BASE');
    fs.writeFileSync(path.join(agentDir, 'AGENTS.local.md'), 'REMEMBER THIS');
    const prompt = buildSystemPrompt(undefined, agentDir, sharedBase);
    expect(prompt).toContain('REMEMBER THIS');
    expect(prompt).toContain('Per-group memory');
  });

  it('falls back to the shared base when no composed AGENTS.md exists', () => {
    fs.writeFileSync(sharedBase, 'FALLBACK SHARED');
    const prompt = buildSystemPrompt(undefined, agentDir, sharedBase);
    expect(prompt).toContain('FALLBACK SHARED');
  });

  it('does not loop on a self-referential import', () => {
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), ['@./AGENTS.md', 'AFTER SELF IMPORT'].join('\n'));
    const prompt = buildSystemPrompt(undefined, agentDir, sharedBase);
    expect(prompt).toContain('AFTER SELF IMPORT');
  });

  it('advertises available skills as a catalog', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-instr-home-'));
    const skillDir = path.join(home, '.agents', 'skills', 'myskill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: myskill\ndescription: Does a thing\n---\n\nbody',
    );
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), 'BASE');

    const prompt = buildSystemPrompt(undefined, agentDir, sharedBase, home);
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('**myskill** — Does a thing');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
