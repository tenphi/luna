import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SKILLS_DISABLED, listBuiltinContainerSkillDirs, resolveContainerSkills } from './container-skills.js';

const TEST_SKILL = '_skills-resolve-test';
const skillsRoot = path.join(process.cwd(), 'container', 'skills');
const testDir = path.join(skillsRoot, TEST_SKILL);

beforeEach(() => {
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'SKILL.md'), '---\nname: test\ndescription: test\n---\n');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('resolveContainerSkills', () => {
  it('excludes default-disabled skills when skills is all', () => {
    const enabled = resolveContainerSkills({ skills: 'all' });
    for (const name of DEFAULT_SKILLS_DISABLED) {
      expect(enabled).not.toContain(name);
    }
    expect(enabled).toContain(TEST_SKILL);
  });

  it('honors explicit skills list', () => {
    const enabled = resolveContainerSkills({
      skills: ['telegram-formatting', TEST_SKILL],
    });
    expect(enabled).toEqual(['telegram-formatting', TEST_SKILL].sort());
  });

  it('skillsEnabled opts back into skills listed in skillsDisabled', () => {
    const enabled = resolveContainerSkills({
      skills: 'all',
      skillsDisabled: [TEST_SKILL],
      skillsEnabled: [TEST_SKILL],
    });
    expect(enabled).toContain(TEST_SKILL);
  });

  it('explicit empty skillsDisabled enables all built-in skills', () => {
    const enabled = resolveContainerSkills({
      skills: 'all',
      skillsDisabled: [],
    });
    expect(enabled).toContain('telegram-formatting');
    expect(enabled).toContain(TEST_SKILL);
  });

  it('skillsDisabled can exclude additional skills', () => {
    const enabled = resolveContainerSkills({
      skills: 'all',
      skillsDisabled: [...DEFAULT_SKILLS_DISABLED, TEST_SKILL],
    });
    expect(enabled).not.toContain(TEST_SKILL);
  });

  it('listBuiltinContainerSkillDirs includes test skill', () => {
    expect(listBuiltinContainerSkillDirs()).toContain(TEST_SKILL);
  });
});
