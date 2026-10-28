import { describe, expect, it } from 'bun:test';
import { isOnlyToolCallText, parseTextToolCalls } from './text-tool-calls.js';

describe('parseTextToolCalls', () => {
  it('returns no calls and unchanged text when there is no tool_calls block', () => {
    const out = parseTextToolCalls('Just a normal reply to the user.');
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe('Just a normal reply to the user.');
  });

  it('parses a single invoke with one parameter (the trip-planner case)', () => {
    const text = `<tool_calls>
<invoke name="Skill">
<parameter name="name">trip-planner</parameter>
</invoke>
</tool_calls>`;
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('Skill');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ name: 'trip-planner' });
    // The raw XML block must be stripped so it never leaks to the channel.
    expect(out.text).toBe('');
  });

  it('tolerates the malformed <parameter=parameter name="..."> variant', () => {
    // Models garble the opening tag under streaming — recover it rather than
    // dropping the whole call.
    const text = `<tool_calls>
<invoke name="Skill">
<parameter=parameter name="name">trip-planner</parameter>
</invoke>
</tool_calls>`;
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('Skill');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ name: 'trip-planner' });
    expect(out.text).toBe('');
  });

  it('parses multiple parameters and multiple invokes', () => {
    const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">echo hi</parameter>
<parameter name="timeout">5000</parameter>
</invoke>
<invoke name="Read">
<parameter name="file_path">/tmp/a.txt</parameter>
</invoke>
</tool_calls>`;
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0]!.function.name).toBe('Bash');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({
      command: 'echo hi',
      timeout: '5000',
    });
    expect(out.toolCalls[1]!.function.name).toBe('Read');
    expect(JSON.parse(out.toolCalls[1]!.function.arguments)).toEqual({ file_path: '/tmp/a.txt' });
  });

  it('keeps surrounding prose and only strips the block', () => {
    const text = `Here is what I will do.
<tool_calls>
<invoke name="Skill">
<parameter name="name">trip-planner</parameter>
</invoke>
</tool_calls>
Let me know if you want changes.`;
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.text.replace(/\n{2,}/g, '\n').trim()).toBe(
      'Here is what I will do.\nLet me know if you want changes.',
    );
  });

  it('returns no calls when the wrapper is present but nothing parses', () => {
    const text = '<tool_calls>not actually a call</tool_calls>';
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toEqual([]);
    // Unparseable block is left intact — we don't strip what we can't interpret.
    expect(out.text).toBe(text);
  });

  it('handles value content containing newlines', () => {
    const text = `<tool_calls>
<invoke name="Bash">
<parameter name="command">cat > /workspace/agent/trip_planner_draft.py << 'PYEOF'
import sys
print("hi")
PYEOF</parameter>
</invoke>
</tool_calls>`;
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    const args = JSON.parse(out.toolCalls[0]!.function.arguments);
    expect(args.command).toContain('import sys');
    expect(args.command).toContain("PYEOF");
  });
});

describe('isOnlyToolCallText', () => {
  it('is true when the text is only a tool-call block', () => {
    expect(
      isOnlyToolCallText(`<tool_calls>
<invoke name="Skill"><parameter name="name">trip-planner</parameter></invoke>
</tool_calls>`),
    ).toBe(true);
  });

  it('is false when there is surrounding prose', () => {
    expect(isOnlyToolCallText('Sure! <tool_calls><invoke name="X"></invoke></tool_calls>')).toBe(false);
  });

  it('is false for plain text with no block', () => {
    expect(isOnlyToolCallText('just an answer')).toBe(false);
  });

  it('parses Gemma 4 self-closing <call:…/> via the unified entry point', () => {
    const text = '<call:web_search query="what is ZQX"/><tool_call|>';
    const out = parseTextToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('web_search');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ query: 'what is ZQX' });
    expect(out.text).toBe('');
  });
});
