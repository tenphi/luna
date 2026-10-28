/**
 * Parse Gemma 4 text-based tool calls that some OpenAI-compatible gateways emit
 * inside `delta.content` instead of populating the structured `tool_calls` field.
 *
 * Gemma 4 uses token-delimited formats such as:
 *   <|tool_call>call:get_weather{location:<|"|>London<|"|>}<tool_call|>
 *
 * Gateways often decode these to plain text with mangled delimiters. Observed
 * variants include bare `call:name{args}`, self-closing `<call:name key="val"/>`,
 * and orphaned `<tool_call|>` closers when the stream is cut off mid-call.
 *
 * Ported from vLLM's tiered Gemma4 parser (gemma4_utils.py) with additions for
 * the self-closing `<call:…/>` form seen on blackbox.ai's Gemma 4 endpoint.
 */

import type { ToolCall } from './types.js';

/** Gemma 4 string-escape token as it appears in decoded text. */
const ESCAPE_TOKEN = '<|"|>';

/** Standard: <|tool_call>call:name{args}<tool_call|> (or <turn|> instead of close). */
const STANDARD_CALL_RE =
  /<\|tool_call\>call:(\w+)\{(.*?)\}(?:<tool_call\|>|<turn\|>)/gs;

/** Fallback bare: call:name{args} or name{args} after whitespace/start. */
const FALLBACK_BRACE_RE = /(?:^|\s|>)call:(\w+)\{(.*?)\}|(?:^|\s)(\w+)\{(.*?)\}/gs;

/** Self-closing: <call:web_search query="what is ZQX"/> */
const SELF_CLOSING_CALL_RE = /<call:(\w+)((?:\s+\w+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*\/?>/gi;

/** XML-style: <tool_call>func_name({...})</tool_call> or <tool_call>call:func{}</tool_call> */
const XML_TOOL_CALL_RE =
  /<tool_call>(?:call:)?(\w+)\((\{[\s\S]*?\})\)|(?:call:)?(\w+)\{([\s\S]*?)\}<\/tool_call>/gi;

/** Orphan Gemma control tokens to strip from visible text. */
const ORPHAN_GEMMA_TOKEN_RE =
  /<\|tool_call\>|<tool_call\|>|<\|tool_response\>|<tool_response\|>|<\|tool\>|<tool\|>|<\|turn\|>|<turn\|>/gi;

/**
 * Parse Gemma4-style compact argument strings.
 * Handles: key:<|"|>value<|"|>, key:"value", key:'value', key:123, key:true
 */
function parseGemma4Args(argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!argsStr?.trim()) return args;

  let m: RegExpExecArray | null;

  // Tier 1: Quoted strings — key:"value" or key:'value'
  const quotedRe = /(\w+)\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g;
  while ((m = quotedRe.exec(argsStr)) !== null) {
    args[m[1]!] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  if (Object.keys(args).length > 0) return args;

  // Tier 2: Gemma escape-token strings — key:<|"|>value<|"|>
  const escapeRe = /(\w+):(?:<\|"\|>(.*?)<\|"\|>|([^,}]*))/gs;
  while ((m = escapeRe.exec(argsStr)) !== null) {
    const key = m[1]!.trim();
    const val = (m[2] ?? m[3] ?? '').trim();
    if (key) args[key] = val;
  }
  if (Object.keys(args).length > 0) return args;

  // Tier 3: Bare values — key:value (no quotes, comma-separated)
  const bareRe = /(\w+)\s*:\s*([^,}]+)/g;
  while ((m = bareRe.exec(argsStr)) !== null) {
    const key = m[1]!.trim();
    let val: unknown = m[2]!.trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val as string)) val = Number(val);
    else if (/^-?\d+\.\d+$/.test(val as string)) val = Number(val);
    if (key) args[key] = val;
  }

  return args;
}

/** Parse HTML-style attributes from a self-closing <call:name …/> tag. */
function parseCallAttributes(attrStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const attrRe = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrStr)) !== null) {
    args[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return args;
}

function makeToolCall(index: number, name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `gemma4call_${index}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** True when text may contain Gemma 4 tool-call markers. */
export function looksLikeGemma4ToolCall(text: string): boolean {
  if (!text) return false;
  return (
    /<\|tool_call\>/i.test(text) ||
    /<tool_call\|>/i.test(text) ||
    /<call:\w+/i.test(text) ||
    /\bcall:\w+\{/i.test(text) ||
    /<tool_call>/i.test(text)
  );
}

/** Strip orphan Gemma control tokens that leak when a call is truncated. */
export function stripOrphanGemmaTokens(text: string): string {
  if (!text || !looksLikeGemma4ToolCall(text)) return text;
  return text.replace(ORPHAN_GEMMA_TOKEN_RE, '').trim();
}

/**
 * Parse Gemma 4 text tool calls from model output. Returns parsed calls and
 * text with all recognized call regions and orphan tokens removed.
 */
export function parseGemma4ToolCalls(text: string): {
  toolCalls: ToolCall[];
  text: string;
} {
  if (!text || !looksLikeGemma4ToolCall(text)) {
    return { toolCalls: [], text };
  }

  const calls: ToolCall[] = [];
  const regions: Array<{ start: number; end: number }> = [];
  let callIndex = 0;

  function addCall(name: string, args: Record<string, unknown>, start: number, end: number): void {
    if (!name) return;
    calls.push(makeToolCall(callIndex++, name, args));
    regions.push({ start, end });
  }

  // Tier 1: Standard <|tool_call>call:name{args}<tool_call|>
  let m: RegExpExecArray | null;
  STANDARD_CALL_RE.lastIndex = 0;
  while ((m = STANDARD_CALL_RE.exec(text)) !== null) {
    addCall(m[1]!, parseGemma4Args(m[2] ?? ''), m.index, m.index + m[0].length);
  }

  // Tier 2: Self-closing <call:name attr="val"/>
  if (calls.length === 0) {
    SELF_CLOSING_CALL_RE.lastIndex = 0;
    while ((m = SELF_CLOSING_CALL_RE.exec(text)) !== null) {
      addCall(m[1]!, parseCallAttributes(m[2] ?? ''), m.index, m.index + m[0].length);
    }
  }

  // Tier 3: XML-style <tool_call>name({...})</tool_call>
  if (calls.length === 0) {
    XML_TOOL_CALL_RE.lastIndex = 0;
    while ((m = XML_TOOL_CALL_RE.exec(text)) !== null) {
      const name = m[1] ?? m[3] ?? '';
      const argsStr = m[2] ?? m[4] ?? '';
      let args: Record<string, unknown> = {};
      try {
        args = argsStr.startsWith('{') ? (JSON.parse(argsStr) as Record<string, unknown>) : parseGemma4Args(argsStr);
      } catch {
        args = parseGemma4Args(argsStr);
      }
      addCall(name, args, m.index, m.index + m[0].length);
    }
  }

  // Tier 4: Fallback bare call:name{args}
  if (calls.length === 0) {
    FALLBACK_BRACE_RE.lastIndex = 0;
    while ((m = FALLBACK_BRACE_RE.exec(text)) !== null) {
      const name = m[1] ?? m[3] ?? '';
      const argsStr = m[2] ?? m[4] ?? '';
      addCall(name, parseGemma4Args(argsStr), m.index, m.index + m[0].length);
    }
  }

  if (calls.length === 0) {
    // Nothing parseable — still strip orphan closers so `<tool_call|>` never leaks.
    return { toolCalls: [], text: stripOrphanGemmaTokens(text) };
  }

  // Remove matched regions (reverse order to preserve indices) plus trailing orphan tokens.
  regions.sort((a, b) => b.start - a.start);
  let stripped = text;
  for (const { start, end } of regions) {
    stripped = stripped.slice(0, start) + stripped.slice(end);
  }
  stripped = stripOrphanGemmaTokens(stripped);

  return { toolCalls: calls, text: stripped.trim() };
}
