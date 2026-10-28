import { describe, it, expect } from 'vitest';
import {
  renderLive,
  renderDone,
  renderCliDone,
  windowLinesForDisplay,
  TELEGRAM_TEXT_CAP,
  MIN_VISIBLE_LINES,
  type StatusLine,
} from './render.js';

function line(
  kind: StatusLine['kind'],
  emoji: string,
  label: string,
  summary: string,
  startedAt: number,
  endedAt?: number,
  doneLabel?: string,
): StatusLine {
  return { kind, emoji, label, summary, startedAt, endedAt, doneLabel };
}

const T0 = 1000;
const NOW = 5000;

describe('renderLive', () => {
  it('returns empty string for no lines', () => {
    expect(renderLive([], NOW)).toBe('');
  });

  it('renders a single active thinking line with timer', () => {
    const lines = [line('thinking', '🤔', 'Thinking', '', T0)];
    const result = renderLive(lines, NOW);
    expect(result).toBe('🤔 Thinking… 4s');
  });

  it('renders active line at 0s when just started', () => {
    const lines = [line('thinking', '🤔', 'Thinking', '', NOW)];
    const result = renderLive(lines, NOW);
    expect(result).toBe('🤔 Thinking…');
  });

  it('renders an active tool line on a single line with inline summary + timer', () => {
    const lines = [line('tool', '🧠', 'Searching', '"Lisbon flights"', T0)];
    const result = renderLive(lines, NOW);
    expect(result).toBe('🧠 Searching · "Lisbon flights" 4s');
  });

  it('renders frozen lines with checkmark + frozen active line', () => {
    const lines = [
      line('thinking', '🤔', 'Thinking', '', 1000, 3000),
      line('tool', '🧠', 'Searching', '"query"', 3000),
    ];
    const result = renderLive(lines, NOW);
    expect(result).toContain('🤔 Thinking ✓ 2s');
    expect(result).toContain('🧠 Searching · "query" 2s');
  });

  it('uses the present-progressive label while active and the past-tense label once frozen', () => {
    const lines = [
      line('tool', '📦', 'Reading skill', 'calendar', 1000, 3000, 'Skill used'),
      line('generating', '🐾', 'Typing', '', 3000),
    ];
    const result = renderLive(lines, NOW);
    expect(result).toContain('📦 Skill used · calendar');
    expect(result).not.toContain('Reading skill');
  });

  it('renders plain text and note lines without prefixes', () => {
    const lines = [
      line('text', '', '', 'Let me look that up.', 1000, 3000),
      line('note', '', '', 'On it…', 3000, 3000),
      line('tool', '🧠', 'Search', '', 3000),
    ];
    const result = renderLive(lines, NOW);
    expect(result).toContain('Let me look that up.');
    expect(result).toContain('On it…');
    expect(result).toContain('🧠 Search');
    expect(result).not.toMatch(/^🐾/m);
  });

  it('collapses consecutive thinking lines into one duration', () => {
    const lines = [line('thinking', '🤔', 'Thinking', '', 1000, 3000), line('thinking', '🤔', 'Thinking', '', 3000)];
    const result = renderLive(lines, NOW);
    expect(result).toBe('🤔 Thinking… 4s');
  });

  it('does not collapse thinking separated by a tool line', () => {
    const lines = [
      line('thinking', '🤔', 'Thinking', '', 1000, 2000),
      line('tool', '🌐', 'Search', '', 2000, 3000),
      line('thinking', '🤔', 'Thinking', '', 3000),
    ];
    const result = renderLive(lines, NOW);
    expect(result).toContain('🤔 Thinking ✓ 1s');
    // Completed tools use the quiet done style: no checkmark, no timer.
    expect(result).toContain('🌐 Search');
    expect(result).not.toContain('🌐 Search ✓');
    expect(result).toContain('🤔 Thinking… 2s');
  });

  it('keeps at least MIN_VISIBLE_LINES when they fit under the char cap', () => {
    const pad = 'x'.repeat(350);
    const lines: StatusLine[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(line('tool', '🔧', `Step ${i}`, pad, i * 1000, (i + 1) * 1000));
    }
    const { lines: windowed, omitted } = windowLinesForDisplay(lines, NOW);
    expect(windowed.length).toBe(MIN_VISIBLE_LINES);
    expect(omitted).toBe(5);
    expect(windowed[0]!.label).toBe('Step 5');
  });

  it('total live output including omitted header stays within TELEGRAM_TEXT_CAP', () => {
    const pad = 'x'.repeat(180);
    const lines: StatusLine[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(line('tool', '🌐', `Search ${i}`, pad, i * 1000, (i + 1) * 1000));
    }
    lines.push(line('tool', '🌐', 'Active', '"current"', 25000));
    const result = renderLive(lines, 30000);
    expect(result.length).toBeLessThanOrEqual(TELEGRAM_TEXT_CAP);
  });

  it('sliding window omits oldest lines with a header when over char cap', () => {
    const pad = 'x'.repeat(180);
    const lines: StatusLine[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(line('tool', '🌐', `Search ${i}`, pad, i * 1000, (i + 1) * 1000));
    }
    lines.push(line('tool', '🌐', 'Active', '"current"', 25000));
    const result = renderLive(lines, 30000);
    expect(result).toMatch(/^… \d+ earlier steps\n/);
    expect(result).toContain('Active');
    expect(result).not.toContain('Search 0');
  });

  it('renders a completed tool on one line with its summary and a quiet done style (no check)', () => {
    const lines = [
      line('tool', '🧠', 'Searching', '"query"', 1000, 3000),
      line('generating', '🐾', 'Typing', '', 3000),
    ];
    const result = renderLive(lines, NOW);
    const rows = result.split('\n');
    expect(rows[0]).toBe('🧠 Searching · "query"');
    expect(rows[1]).toBe('🐾 Typing… 2s');
  });
});

describe('renderDone', () => {
  it('renders done header with total time', () => {
    const lines: StatusLine[] = [];
    const result = renderDone(lines, 0, 9000);
    expect(result).toBe('✅ Done in 9s');
  });

  it('includes tool lines in done output', () => {
    const lines = [
      line('thinking', '🤔', 'Thinking', '', 0, 2000),
      line('tool', '🧠', 'Search', '"Lisbon flights under €200"', 2000, 3000),
      line('tool', '📅', 'List events', 'next 7 days', 3000, 7000),
      line('generating', '🐾', 'Typing', '', 7000, 9000),
    ];
    const result = renderDone(lines, 0, 9000);
    expect(result).toContain('✅ Done in 9s');
    expect(result).toContain('🧠 Search · "Lisbon flights under €200"');
    expect(result).toContain('📅 List events · next 7 days');
    // thinking and generating lines are excluded
    expect(result).not.toContain('Thinking');
    expect(result).not.toContain('Typing');
  });

  it('excludes plain text and note lines from done output', () => {
    const lines = [
      line('text', '', '', 'scratch preamble', 0, 1000),
      line('note', '', '', 'On it…', 1000, 2000),
      line('tool', '🧠', 'Search', '"query"', 2000, 4000),
    ];
    const result = renderDone(lines, 0, 5000);
    expect(result).toContain('🧠 Search · "query"');
    expect(result).not.toContain('scratch preamble');
    expect(result).not.toContain('On it…');
  });

  it('shows tool lines without summary when summary is empty', () => {
    const lines = [line('tool', '🧠', 'List pages', '', 0, 2000)];
    const result = renderDone(lines, 0, 5000);
    expect(result).toContain('🧠 List pages');
    // No trailing ·
    expect(result).not.toMatch(/🧠 List pages ·/);
  });

  it('uses the past-tense doneLabel in the collapsed summary', () => {
    const lines = [line('tool', '📦', 'Reading skill', 'calendar', 0, 2000, 'Skill used')];
    const result = renderDone(lines, 0, 5000);
    expect(result).toContain('📦 Skill used · calendar');
    expect(result).not.toContain('Reading skill');
  });
});

describe('renderCliDone', () => {
  it('renders compact one-liner with tool names', () => {
    const lines = [
      line('tool', '🧠', 'Search', '"query"', 0, 2000),
      line('tool', '📅', 'List events', 'next 7 days', 2000, 5000),
    ];
    const result = renderCliDone(lines, 0, 9000);
    expect(result).toBe('✅ Done in 9s · 🧠 Search · 📅 List events');
  });

  it('renders without tool suffix when no tools', () => {
    const result = renderCliDone([], 0, 12000);
    expect(result).toBe('✅ Done in 12s');
  });

  it('uses the past-tense doneLabel in the compact one-liner', () => {
    const lines = [line('tool', '📦', 'Reading skill', 'calendar', 0, 2000, 'Skill used')];
    const result = renderCliDone(lines, 0, 5000);
    expect(result).toBe('✅ Done in 5s · 📦 Skill used');
  });
});

it('includes the reasoning effort in Telegram and CLI completed status', () => {
  expect(renderDone([], 0, 12000, 'high')).toBe('✅ Done in 12s · reasoning: high');
  expect(renderCliDone([], 0, 12000, 'medium')).toBe('✅ Done in 12s · reasoning: medium');
});
