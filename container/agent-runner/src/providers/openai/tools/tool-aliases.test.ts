import { describe, expect, it } from 'bun:test';

import {
  exposeToolName,
  isLunaProgressHiddenTool,
  isUserFacingSendToolName,
  legacyMcpToolName,
  resolveToolName,
} from './tool-aliases.js';

describe('tool-aliases', () => {
  it('exposes curated domain names', () => {
    expect(exposeToolName('apple_calendar', 'list_events')).toBe('list_calendar_events');
    expect(exposeToolName('apple_reminders', 'create_reminder')).toBe('create_reminder');
    expect(exposeToolName('apple_reminders', 'get_reminder')).toBe('get_reminder');
    expect(exposeToolName('apple_contacts', 'search_contacts')).toBe('search_contacts');
    expect(exposeToolName('apple_messages', 'send_message')).toBe('send_imessage');
    expect(exposeToolName('luna', 'ask_user_question')).toBe('ask_question');
    expect(exposeToolName('luna', 'send_message')).toBe('send_message');
    expect(exposeToolName('tavily', 'search')).toBe('web_search');
    expect(exposeToolName('tavily', 'tavily_search')).toBe('web_search');
  });

  it('falls back to server_tool for unknown servers', () => {
    expect(exposeToolName('vulpine', 'cashflow')).toBe('vulpine_cashflow');
  });

  // The memory backend's name must never reach the agent. An uncurated op (a
  // custom toolsAllow naming something the alias map does not cover) is the one
  it('names an uncurated memory op after its server', () => {
    expect(exposeToolName('memory', 'recall')).toBe('memory_recall');
    expect(exposeToolName('memory', 'ingest')).toBe('memory_ingest');
  });

  // resolveToolName's fallback has to agree with exposeToolName's, or a legacy
  // call would normalize to a name that was never advertised.
  it('resolves an uncurated legacy memory name to the advertised fallback', () => {
    expect(resolveToolName('mcp__memory__recall')).toBe(exposeToolName('memory', 'recall'));
    expect(resolveToolName('mcp__memory__recall')).toBe('memory_recall');
  });

  it('curates apple_messages send as send_imessage', () => {
    expect(exposeToolName('apple_messages', 'send_message')).toBe('send_imessage');
    expect(exposeToolName('apple_messages', 'list_chats')).toBe('list_imessage_chats');
  });

  it('resolves legacy mcp__ names to exposed names', () => {
    expect(resolveToolName('mcp__memory__write')).toBe('memory_write');
    expect(resolveToolName('mcp__apple_calendar__list_events')).toBe('list_calendar_events');
    expect(resolveToolName('mcp__luna__ask_user_question')).toBe('ask_question');
  });

  it('keeps curated exposed names collision-free for known servers', () => {
    const seen = new Set<string>();
    for (const [server, tools] of Object.entries({
      memory: ['recall', 'write'],
      luna: ['send_message'],
      apple_calendar: ['list_events'],
    })) {
      for (const tool of tools) {
        const exposed = exposeToolName(server, tool);
        expect(seen.has(exposed), `collision on ${exposed} (${server}/${tool})`).toBe(false);
        seen.add(exposed);
      }
    }
    expect(exposeToolName('luna', 'send_message')).not.toBe(exposeToolName('apple_messages', 'send_message'));
  });

  it('builds legacy mcp names for compatibility', () => {
    expect(legacyMcpToolName('memory', 'write')).toBe('mcp__memory__write');
  });

  it('detects user-facing send tools under new and legacy names', () => {
    expect(isUserFacingSendToolName('send_message')).toBe(true);
    expect(isUserFacingSendToolName('ask_question')).toBe(true);
    expect(isUserFacingSendToolName('mcp__luna__send_message')).toBe(true);
    expect(isUserFacingSendToolName('mcp__luna__ask_user_question')).toBe(true);
    expect(isUserFacingSendToolName('send_email')).toBe(false);
    expect(isUserFacingSendToolName('get_memory_page')).toBe(false);
  });

  it('hides luna plumbing from progress', () => {
    expect(isLunaProgressHiddenTool('send_message')).toBe(true);
    expect(isLunaProgressHiddenTool('ask_question')).toBe(true);
    expect(isLunaProgressHiddenTool('mcp__luna__schedule_task')).toBe(true);
    expect(isLunaProgressHiddenTool('get_memory_page')).toBe(false);
  });
});
