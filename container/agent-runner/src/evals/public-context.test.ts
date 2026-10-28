import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicContext } from './public-context.js';

test('public evaluation ignores authored skills and per-install instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-context-fixture-'));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('container/AGENTS.md', 'PUBLIC BASE');
  for (const name of ['tools', 'memory', 'reminders', 'episodes'])
    write(`container/fragments/${name}.md`, `PUBLIC ${name}`);
  write('container/agent-runner/src/mcp-tools/core.instructions.md', 'PUBLIC CORE');
  write('container/skills/example/SKILL.md', '---\nname: example\ndescription: Public workflow\n---\nPUBLIC SKILL');
  write('agent/AGENTS.local.md', 'PRIVATE LOCAL CANARY');
  write('agent/skills/private-canary/SKILL.md', '---\nname: private-canary\ndescription: PRIVATE CANARY\n---');
  const previous = process.env.LUNA_AGENT_SKILLS_PATH;
  process.env.LUNA_AGENT_SKILLS_PATH = path.join(root, 'agent/skills');
  const context = createPublicContext(root);
  try {
    expect(context.prompt()).toContain('PUBLIC BASE');
    expect(context.prompt()).toContain('**example**');
    expect(context.prompt()).not.toContain('CANARY');
    expect(context.skill('example')?.content).toContain('PUBLIC SKILL');
    expect(context.skill('private-canary')).toBeNull();
    expect(Object.keys(context.manifest.assets).every((file) => file.startsWith('container/'))).toBe(true);
  } finally {
    context.dispose();
    if (previous === undefined) delete process.env.LUNA_AGENT_SKILLS_PATH;
    else process.env.LUNA_AGENT_SKILLS_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
