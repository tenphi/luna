/**
 * Built-in container skills under `container/skills/`.
 *
 * With `skills: "all"`, exclusions come from `skillsDisabled` in
 * `container.json` (default: `DEFAULT_SKILLS_DISABLED`). Use `skillsEnabled`
 * to opt back in without listing every skill.
 */
import fs from 'fs';
import path from 'path';

/** Written into new `container.json` files and assumed when the field is omitted. */
export const DEFAULT_SKILLS_DISABLED = [] as const;

export interface ContainerSkillSelection {
  skills: string[] | 'all';
  skillsDisabled?: string[];
  skillsEnabled?: string[];
}

/** List skill folder names shipped in `container/skills/`. */
export function listBuiltinContainerSkillDirs(projectRoot = process.cwd()): string[] {
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs
    .readdirSync(skillsDir)
    .filter((entry) => {
      try {
        return fs.statSync(path.join(skillsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Resolve the enabled built-in skill set for spawn, AGENTS.md, and stats. */
export function resolveContainerSkills(selection: ContainerSkillSelection, projectRoot = process.cwd()): string[] {
  const all = listBuiltinContainerSkillDirs(projectRoot);
  const allSet = new Set(all);

  if (selection.skills !== 'all') {
    return selection.skills.filter((name) => allSet.has(name)).sort();
  }

  const disabled = new Set<string>([...(selection.skillsDisabled ?? DEFAULT_SKILLS_DISABLED)]);
  for (const name of selection.skillsEnabled ?? []) {
    disabled.delete(name);
  }

  return all.filter((name) => !disabled.has(name));
}
