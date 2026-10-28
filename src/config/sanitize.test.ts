import { describe, expect, it } from 'vitest';

import { sanitizeAgentForLocalOverlay } from './sanitize.js';

describe('sanitizeAgentForLocalOverlay', () => {
  it('strips default skillsDisabled and cliScope', () => {
    const out = sanitizeAgentForLocalOverlay({
      skills: 'all',
      skillsDisabled: [],
      skillsEnabled: [],
      cliScope: 'agent',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
    });
    expect(out.skillsDisabled).toBeUndefined();
    expect(out.skillsEnabled).toBeUndefined();
    expect(out.cliScope).toBeUndefined();
    expect(out.mcpServers).toBeUndefined();
    expect(out.packages).toBeUndefined();
  });

  it('keeps skillsEnabled opt-in and strips legacy agent fields', () => {
    const out = sanitizeAgentForLocalOverlay({
      provider: 'openai',
      model: 'x',
      assistantName: 'Luna',
      cliScope: 'global',
      mcpServers: { tavily: { command: 'tavily-mcp', args: [] } },
      skillsEnabled: ['telegram-formatting'],
    });
    expect(out.mcpServers).toBeUndefined();
    expect(out.provider).toBeUndefined();
    expect(out.cliScope).toBeUndefined();
    expect(out.skillsEnabled).toEqual(['telegram-formatting']);
  });
});
