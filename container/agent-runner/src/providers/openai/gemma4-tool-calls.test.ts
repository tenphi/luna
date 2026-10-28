import { describe, expect, it } from 'bun:test';

import {
  looksLikeGemma4ToolCall,
  parseGemma4ToolCalls,
  stripOrphanGemmaTokens,
} from './gemma4-tool-calls.js';

describe('parseGemma4ToolCalls', () => {
  it('parses the standard <|tool_call>call:name{args}<tool_call|> format', () => {
    const text =
      '<|tool_call>call:get_weather{location:<|"|>London<|"|>}<tool_call|>';
    const out = parseGemma4ToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('get_weather');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ location: 'London' });
    expect(out.text).toBe('');
  });

  it('parses the self-closing <call:name attr="val"/> format (blackbox Gemma 4 leak)', () => {
    const text = '<call:web_search query="what is ZQX"/>';
    const out = parseGemma4ToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('web_search');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ query: 'what is ZQX' });
    expect(out.text).toBe('');
  });

  it('parses self-closing call plus orphaned <tool_call|> closer (ZQX regression)', () => {
    const text =
      '<internal>\nThe user is asking for the meaning of "ZQX". I will perform a web search.\n</internal><call:web_search query="what is ZQX"/><tool_call|>';
    const out = parseGemma4ToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('web_search');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ query: 'what is ZQX' });
    expect(out.text).not.toContain('<tool_call|>');
    expect(out.text).not.toContain('<call:');
  });

  it('parses fallback bare call:name{args}', () => {
    const text = 'Let me check. call:get_temperature{location:<|"|>Paris<|"|>}';
    const out = parseGemma4ToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]!.function.name).toBe('get_temperature');
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ location: 'Paris' });
    expect(out.text).toBe('Let me check.');
  });

  it('parses quoted args in brace syntax', () => {
    const text = '<|tool_call>call:search{query:"hello world"}<tool_call|>';
    const out = parseGemma4ToolCalls(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(JSON.parse(out.toolCalls[0]!.function.arguments)).toEqual({ query: 'hello world' });
  });

  it('strips orphan tokens when nothing parseable remains', () => {
    expect(stripOrphanGemmaTokens('<tool_call|>')).toBe('');
    expect(stripOrphanGemmaTokens('answer<tool_call|>')).toBe('answer');
  });

  it('returns unchanged text when no Gemma markers are present', () => {
    const out = parseGemma4ToolCalls('Just a normal reply.');
    expect(out.toolCalls).toEqual([]);
    expect(out.text).toBe('Just a normal reply.');
  });
});

describe('looksLikeGemma4ToolCall', () => {
  it('detects Gemma markers', () => {
    expect(looksLikeGemma4ToolCall('<call:web_search query="x"/>')).toBe(true);
    expect(looksLikeGemma4ToolCall('<tool_call|>')).toBe(true);
    expect(looksLikeGemma4ToolCall('plain text')).toBe(false);
  });
});
