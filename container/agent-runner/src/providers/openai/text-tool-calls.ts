/**
 * Parse text-based tool-call XML that some OpenAI-compatible models emit inside
 * `delta.content` instead of using the structured `tool_calls` field.
 *
 * Many open-weight models (Hermes/Qwen/Nexus-style function-calling fine-tunes)
 * are trained to emit tool calls as an XML block in the assistant text, of the form:
 *
 *   <tool_calls>
 *   <invoke name="Skill">
 *   <parameter name="name">bank-review</parameter>
 *   </invoke>
 *   </tool_calls>
 *
 * The structured OpenAI `tool_calls` field never gets populated on these endpoints,
 * so the agent loop would otherwise (a) never execute the intended tool and
 * (b) deliver the raw XML to the user as the "answer" — producing a corrupted,
 * unanswered turn. This module detects such emissions and converts them back
 * into the same `ToolCall` shape the provider expects from the native field,
 * and strips the block from the visible text so it never leaks to a channel.
 *
 * The parser is deliberately tolerant: malformed self-closing variants
 * (`<parameter=parameter name="…">`, missing wrappers, stray whitespace) are
 * recovered where possible because models garble the format under streaming.
 */

import { looksLikeGemma4ToolCall, parseGemma4ToolCalls } from './gemma4-tool-calls.js';
import type { ToolCall } from './types.js';

/** Match the entire <tool_calls>…</tool_calls> region (greedy, last close). */
const TOOL_CALLS_BLOCK_RE = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;

/** A single invoke block: <invoke name="X">…</invoke> (also <tool_call name="X">). */
const INVOKE_RE =
  /<(?:invoke|tool_call|function)[^>]*?\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/(?:invoke|tool_call|function)>/gi;

/** A parameter line: <parameter name="k">v</parameter> (tolerant of `=` typos). */
const PARAM_RE = /<parameter[^>]*?\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;

/**
 * Try to parse a `<tool_calls>…</tool_calls>` block from the model's text output
 * into structured tool calls. Returns the parsed calls plus the text with the
 * block(s) removed. When no block is present (or nothing parseable is found),
 * returns `{ toolCalls: [], text }` unchanged.
 *
 * Never throws — a parse failure just means the text is passed through as-is.
 */
export function parseTextToolCalls(text: string): {
  toolCalls: ToolCall[];
  text: string;
} {
  if (!text) {
    return { toolCalls: [], text };
  }

  // Gemma 4 token-delimited calls (<|tool_call>call:…{}, <call:name …/>, etc.)
  if (looksLikeGemma4ToolCall(text)) {
    const gemma = parseGemma4ToolCalls(text);
    if (gemma.toolCalls.length > 0) return gemma;
    // Fall through — orphan tokens may have been stripped even with no parseable call.
    if (gemma.text !== text) return gemma;
  }

  if (!/<tool_calls>/i.test(text)) {
    return { toolCalls: [], text };
  }

  const calls: ToolCall[] = [];
  let callIndex = 0;
  let madeProgress = false;

  let blockMatch: RegExpExecArray | null;
  TOOL_CALLS_BLOCK_RE.lastIndex = 0;
  while ((blockMatch = TOOL_CALLS_BLOCK_RE.exec(text)) !== null) {
    const inner = blockMatch[1] ?? '';

    INVOKE_RE.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_RE.exec(inner)) !== null) {
      const name = (invokeMatch[1] ?? '').trim();
      const body = invokeMatch[2] ?? '';
      if (!name) continue;

      const args: Record<string, unknown> = {};
      PARAM_RE.lastIndex = 0;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = PARAM_RE.exec(body)) !== null) {
        const key = (paramMatch[1] ?? '').trim();
        if (!key) continue;
        args[key] = (paramMatch[2] ?? '').trim();
      }

      calls.push({
        id: `textcall_${callIndex}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      });
      callIndex++;
      madeProgress = true;
    }
  }

  if (!madeProgress) {
    return { toolCalls: [], text };
  }

  const stripped = text.replace(TOOL_CALLS_BLOCK_RE, '').trim();
  return { toolCalls: calls, text: stripped };
}

/** True if `text` looks like it is *only* a tool-call XML block (no prose). */
export function isOnlyToolCallText(text: string): boolean {
  if (!text || !/<tool_calls>/i.test(text)) return false;
  const { text: stripped } = parseTextToolCalls(text);
  return stripped.length === 0;
}
