/**
 * Strip reasoning / "thinking" tags that some OpenAI-compatible reasoning models
 * (or their hosting gateways) leak into `delta.content` instead of confining to
 * the separate `reasoning_content` field.
 *
 * Observed with MiniMax-M3 on DeepInfra: the chat template wraps the model's
 * chain-of-thought in `<mm:think>…</mm:think>` and streams it through
 * `reasoning_content`, but the boundary tags — usually a stray `</mm:think>`,
 * occasionally a whole block — bleed into `content`. Left untouched they either
 * pollute the visible reply or, when the real answer is cut off and only the
 * tag survives, masquerade as text. Other open-weight reasoning models leak
 * plain `<think>…</think>` the same way.
 *
 * We drop complete think blocks first, then any orphaned open/close tags. The
 * matcher is deliberately tolerant of unknown namespaces (`<mm:think>`,
 * `<foo:think>`) and attributes, and only ever touches actual `<…think…>` tags —
 * prose like "I think so" is never affected.
 */
const THINK_BLOCK_RE = /<(?:[a-z][\w-]*:)?think\b[^>]*>[\s\S]*?<\/(?:[a-z][\w-]*:)?think\s*>/gi;
const STRAY_THINK_TAG_RE = /<\/?(?:[a-z][\w-]*:)?think\b[^>]*>/gi;

/** Gemma 4 and similar models leak chain-of-thought in `<internal>…</internal>`. */
const INTERNAL_BLOCK_RE = /<internal\b[^>]*>[\s\S]*?<\/internal\s*>/gi;
const STRAY_INTERNAL_TAG_RE = /<\/?internal\b[^>]*>/gi;

export function stripReasoningTags(text: string): string {
  if (!text || !text.includes('<')) return text;
  return text
    .replace(THINK_BLOCK_RE, '')
    .replace(STRAY_THINK_TAG_RE, '')
    .replace(INTERNAL_BLOCK_RE, '')
    .replace(STRAY_INTERNAL_TAG_RE, '');
}

/**
 * Strip "harmony" response-format control tokens (GPT-OSS and lookalikes) that a
 * gateway leaks into `delta.content` instead of parsing.
 *
 * Harmony structures a turn as `<|channel|>NAME<|message|>BODY` groups —
 * `analysis`/`thought` hold chain-of-thought, `final` holds the answer — with
 * `<|start|>`/`<|end|>`/`<|return|>` framing. When these bleed into `content`
 * the user sees raw tokens and the reasoning channel name (observed: a bare
 * `thought` label plus mangled `<|channel>` / `<channel|>` markers where one
 * pipe was dropped). We keep only the final answer (the last non-empty segment
 * after the markers) and drop the reasoning preamble.
 *
 * The marker matcher deliberately requires at least one pipe so it never
 * collides with the agent's own `<message to="…">` addressing tags or ordinary
 * angle-bracket prose.
 */
const HARMONY_MARKER_RE =
  /<(?:\|(?:start|end|message|channel|constrain|return|call)\|?|(?:start|end|message|channel|constrain|return|call)\|)>/gi;
const HARMONY_LABEL_RE = /^(?:analysis|commentary|final|thought|assistant|developer|system|user)$/i;
const HARMONY_LEADING_LABEL_RE =
  /^[ \t]*(?:analysis|commentary|final|thought|assistant|developer|system|user)\b[ \t]*\r?\n/i;

export function stripHarmonyMarkers(text: string): string {
  if (!text) return text;
  const segments = text.split(HARMONY_MARKER_RE);
  if (segments.length === 1) {
    // No markers — but a leaked channel/role label on its own is not an answer.
    return HARMONY_LABEL_RE.test(text.trim()) ? '' : text;
  }
  const nonEmpty = segments.filter((s) => s.trim().length > 0);
  let tail = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1]! : '';
  tail = tail.replace(HARMONY_LEADING_LABEL_RE, '');
  if (HARMONY_LABEL_RE.test(tail.trim())) return '';
  return tail;
}

/** Strip both harmony control tokens and `<think>`-style reasoning tags. */
export function stripReasoningArtifacts(text: string): string {
  return stripReasoningTags(stripHarmonyMarkers(text));
}
