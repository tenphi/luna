import { describe, expect, it } from 'vitest';

import { formatToolLine } from './format-tool-line.js';

describe('formatToolLine', () => {
  it('formats name only when args empty', () => {
    expect(formatToolLine('Read', {})).toBe('→ Read');
  });

  it('formats compact key=value params', () => {
    expect(formatToolLine('Read', { path: 'src/router.ts' })).toBe('→ Read path=src/router.ts');
  });

  it('truncates to 80 characters with ellipsis', () => {
    const line = formatToolLine('Bash', {
      command: 'pnpm test --filter router --reporter verbose --runInBand 2>&1 | tee /tmp/out.log | head -n 200',
    });
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line.endsWith('…')).toBe(true);
  });

  it('collapses whitespace in string values', () => {
    const line = formatToolLine('Bash', { command: 'echo   hello\nworld' });
    expect(line).toContain('command=echo hello world');
  });

  it('handles MCP tool names', () => {
    const line = formatToolLine('mcp__luna__send_message', { to: 'cli', text: 'On it' });
    expect(line.startsWith('→ mcp__luna__send_message')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(80);
  });
});
