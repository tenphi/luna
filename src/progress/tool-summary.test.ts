import { describe, it, expect } from 'vitest';
import { summarizeTool, prettifyToolName } from './tool-summary.js';

describe('prettifyToolName', () => {
  it('capitalizes first word and joins with spaces', () => {
    expect(prettifyToolName('put_page')).toBe('Put page');
    expect(prettifyToolName('list_events')).toBe('List events');
    expect(prettifyToolName('search')).toBe('Search');
    expect(prettifyToolName('create_reminder')).toBe('Create reminder');
  });
});

describe('summarizeTool — verb-aware labels (present → past)', () => {
  it('maps Skill to "Reading skill" → "Skill used" with the name summary', () => {
    const r = summarizeTool('Skill', { name: 'calendar' });
    expect(r.emoji).toBe('📦');
    expect(r.activeLabel).toBe('Reading skill');
    expect(r.doneLabel).toBe('Skill used');
    expect(r.summary).toBe('calendar');
  });

  it('maps put_memory_page to "Memorizing" → "Remembered"', () => {
    const r = summarizeTool('put_memory_page', { slug: 'personal/game-list' });
    expect(r.emoji).toBe('🧠');
    expect(r.activeLabel).toBe('Memorizing');
    expect(r.doneLabel).toBe('Remembered');
    expect(r.summary).toBe('personal/game-list');
  });

  it('maps edit_memory_page to "Updating memory" → "Memory updated"', () => {
    const r = summarizeTool('edit_memory_page', {
      slug: 'personal/game-list',
      old_string: '## To play',
      new_string: '## To play\n- X',
    });
    expect(r.emoji).toBe('🧠');
    expect(r.activeLabel).toBe('Updating memory');
    expect(r.doneLabel).toBe('Memory updated');
    expect(r.summary).toContain('personal/game-list');
  });

  describe('edit_memory_page summary', () => {
    it('shows what was written, not a clipped old/new pair', () => {
      // The regression: both strings opened with the same field label, so 40
      // chars of each printed the label twice and cut off the value.
      const r = summarizeTool('edit_memory_page', {
        slug: 'people/bo-winters',
        old_string: '- **Vulpine Mutual membership number:** 1111111111',
        new_string: '- **Vulpine Mutual membership number:** 2222222222',
      });
      expect(r.summary).toBe('people/bo-winters · Vulpine Mutual membership number: 2222222222');
      expect(r.summary).not.toContain('new_string');
      expect(r.summary).not.toContain('old_string');
    });

    it('names what left when the edit removes text', () => {
      const r = summarizeTool('edit_memory_page', {
        slug: 'people/bo-winters',
        old_string: '- **Vulpine Mutual membership number:** 2222222222',
        new_string: '',
      });
      expect(r.summary).toBe('people/bo-winters · removed Vulpine Mutual membership number: 2222222222');
    });

    it('falls back to the slug alone when there is nothing to show', () => {
      expect(summarizeTool('edit_memory_page', { slug: 'people/bo-winters' }).summary).toBe('people/bo-winters');
    });
  });

  it('maps web_search to "Searching" → "Searched"', () => {
    const r = summarizeTool('web_search', { query: 'cheap flights' });
    expect(r.emoji).toBe('🌐');
    expect(r.activeLabel).toBe('Searching');
    expect(r.doneLabel).toBe('Searched');
    expect(r.summary).toBe('"cheap flights"');
  });

  it('derives generic verbs from the operation token', () => {
    const list = summarizeTool('list_calendar_events', { from: '2026-06-10', to: '2026-06-17' });
    expect(list.emoji).toBe('📅');
    expect(list.activeLabel).toBe('Listing calendar events');
    expect(list.doneLabel).toBe('Listed calendar events');
    expect(list.summary).toContain('2026-06-10');

    const create = summarizeTool('create_calendar_event', { title: 'Dentist' });
    expect(create.activeLabel).toBe('Creating calendar event');
    expect(create.doneLabel).toBe('Created calendar event');
    expect(create.summary).toBe('Dentist');
  });

  it('maps get/read to "Reading" → "Read"', () => {
    const r = summarizeTool('get_memory_page', { slug: 'personal/game-list' });
    expect(r.emoji).toBe('🧠');
    expect(r.activeLabel).toBe('Reading memory page');
    expect(r.doneLabel).toBe('Read memory page');
    expect(r.summary).toBe('personal/game-list');
  });
});

describe('summarizeTool — drift fixes (uncurated exposed names)', () => {
  it('handles server-prefixed email_read_message', () => {
    const r = summarizeTool('email_read_message', { folder: 'INBOX', id: '100042' });
    expect(r.emoji).toBe('✉️');
    expect(r.activeLabel).toBe('Reading message');
    expect(r.doneLabel).toBe('Message read');
    expect(r.summary).toBe('id=100042');
  });

  it('handles email_list_envelopes with a trimmed done summary', () => {
    const r = summarizeTool('email_list_envelopes', {
      folder: 'INBOX',
      subject: 'Vulpine Mutual',
      page: 1,
      pageSize: 20,
    });
    expect(r.emoji).toBe('✉️');
    expect(r.activeLabel).toBe('Listing envelopes');
    expect(r.doneLabel).toBe('Envelopes listed');
    expect(r.summary).toContain('subject=Vulpine Mutual');
  });

  it('handles the uncurated tavily_tavily_research name as web Research', () => {
    const r = summarizeTool('tavily_tavily_research', { input: 'Research the tides at Blackwater Bay' });
    expect(r.emoji).toBe('🌐');
    expect(r.activeLabel).toBe('Researching');
    expect(r.doneLabel).toBe('Researched');
    expect(r.summary).toContain('Blackwater Bay');
  });

  it('handles web_map', () => {
    const r = summarizeTool('web_map', { url: 'https://example.com' });
    expect(r.emoji).toBe('🌐');
    expect(r.activeLabel).toBe('Mapping');
    expect(r.doneLabel).toBe('Mapped');
    expect(r.summary).toBe('https://example.com');
  });

  it('maps apple_contacts tools to the contacts emoji', () => {
    const r = summarizeTool('search_contacts', { query: 'Jane' });
    expect(r.emoji).toBe('👤');
    expect(r.activeLabel).toBe('Searching contacts');
    expect(r.doneLabel).toBe('Searched contacts');
    expect(r.summary).toBe('"Jane"');
  });

  it('gives an unknown server tool a decent generic label + emoji', () => {
    const r = summarizeTool('vulpine_list_payments', { account: 'main' });
    expect(r.emoji).toBe('💳');
    expect(r.activeLabel).toBe('Listing payments');
    expect(r.doneLabel).toBe('Listed payments');
  });
});

describe('summarizeTool — built-in tools', () => {
  it('maps Bash to "Running" → "Ran" with the command summary', () => {
    const r = summarizeTool('Bash', { command: 'ls -la' });
    expect(r.emoji).toBe('⚙️');
    expect(r.activeLabel).toBe('Running');
    expect(r.doneLabel).toBe('Ran');
    expect(r.summary).toBe('ls -la');
  });

  it('maps Read with file path', () => {
    const r = summarizeTool('Read', { path: 'src/index.ts' });
    expect(r.emoji).toBe('🔎');
    expect(r.activeLabel).toBe('Reading');
    expect(r.doneLabel).toBe('Read');
    expect(r.summary).toBe('src/index.ts');
  });

  it('maps Grep with pattern', () => {
    const r = summarizeTool('Grep', { pattern: 'sendMessage' });
    expect(r.emoji).toBe('🔎');
    expect(r.summary).toBe('/sendMessage/');
  });

  it('maps Write with file path', () => {
    const r = summarizeTool('Write', { path: 'out.txt', contents: 'hello' });
    expect(r.emoji).toBe('✏️');
    expect(r.activeLabel).toBe('Writing');
    expect(r.doneLabel).toBe('Wrote');
    expect(r.summary).toBe('out.txt');
  });
});

describe('summarizeTool — generic fallback', () => {
  it('picks a single meaningful arg instead of dumping every key=value', () => {
    const r = summarizeTool('do_thing', { title: 'Important', foo: 'bar', baz: 'qux' });
    expect(r.activeLabel).toBe('Running thing');
    expect(r.summary).toBe('Important');
  });

  it('falls back to compacted args when no meaningful key is present', () => {
    const r = summarizeTool('do_thing', { alpha: 'a', beta: 'b' });
    expect(r.summary).toContain('alpha=a');
  });
});

describe('summarizeTool — legacy mcp__ names', () => {
  it('strips mcp__ prefix and maps memory emoji + labels', () => {
    const r = summarizeTool('mcp__memory__put_page', { slug: 'my-page' });
    expect(r.emoji).toBe('🧠');
    expect(r.activeLabel).toBe('Memorizing');
    expect(r.doneLabel).toBe('Remembered');
    expect(r.summary).toBe('my-page');
  });

  it('uses brain emoji for memory tool names even with a wrong server prefix', () => {
    const r = summarizeTool('mcp__vulpine__recall', { text: 'prefs' });
    expect(r.emoji).toBe('🧠');
    expect(r.activeLabel).toBe('Recalling memory');
    expect(r.summary).toBe('prefs');
  });

  it('maps apple_calendar legacy names with the calendar emoji', () => {
    const r = summarizeTool('mcp__apple_calendar__list_events', { start: '2026-06-10', end: '2026-06-17' });
    expect(r.emoji).toBe('📅');
    expect(r.activeLabel).toBe('Listing events');
  });

  it('uses generic emoji for unknown servers', () => {
    const r = summarizeTool('mcp__custom_server__do_thing', { key: 'val' });
    expect(r.emoji).toBe('🔧');
    expect(r.activeLabel).toBe('Running thing');
  });
});
