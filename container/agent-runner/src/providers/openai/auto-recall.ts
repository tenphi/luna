import type { ChatMessage } from './types.js';
import { isInjectedBlock, stripAttachmentAnnotations, unwrapUserText } from './episodes/format.js';

const TRIVIAL_REPLY_RE =
  /^(?:y|n|yes|no|yeah|yep|nope|ok|okay|sure|stop|done|thanks?|thank you|k|cool|hi|hello|hey|sí|si|no|vale|claro|gracias|oui|non|d'accord|merci|ja|nein|danke|bitte|ja|da|net|spasibo|да|нет|спасибо|はい|いいえ|ありがとう|すみません|是|不是|不|好|好的|谢谢|謝謝|예|아니요|고마워|감사합니다)$/iu;

/**
 * How long the pre-turn memory prefetch may take before the turn proceeds without it.
 *
 * This has to sit above the operation's normal retrieval and optional qualification spread, not in
 * the middle of it. Ordinary model variance must not make a healthy memory service look absent.
 *
 * Qualification can return useful evidence after the former 15-second window. The 30-second
 * default covers that latency spread while keeping a stalled prefetch bounded. Prefetch starts
 * before the topic decision, so retrieval can overlap work the turn already does.
 *
 * Akno's precision-first profile avoids qualification when strong deterministic evidence is
 * already sufficient; this deadline covers the ambiguous cases where qualification is useful.
 */
export const DEFAULT_AUTO_RECALL_TIMEOUT_MS = 30_000;
/** Akno's precision-first profile default, made explicit at the host boundary. */
export const DEFAULT_AUTO_RECALL_BUDGET_TOKENS = 1_200;
/** Default cap for pinned `users/shared` + `users/{username}` injection. */
export const DEFAULT_HOT_MEMORY_BUDGET_CHARS = 10_000;
export const HOT_MEMORY_SHARED_SLUG = 'users/shared';

export interface RecallBridge {
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Hidden host-owned calls bypass the model-visible toolsAllow surface. */
  callRaw?(server: string, tool: string, args: Record<string, unknown>): Promise<string>;
}

export type HotMemoryRecall =
  | { available: true; facts: string }
  | { available: false; reason: 'missing-tool' | 'timeout' | 'error' };

export interface AutoRecallConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type AutoRecallReferenceResolution = 'not_needed' | 'resolved' | 'ambiguous' | 'unresolved';

export type AutoRecallContext =
  | {
      available: true;
      status: 'ok' | 'empty' | 'degraded';
      evidence: string;
      memoryView?: MemoryView;
      selected: number;
      budgetUsed: number;
      qualificationRun: boolean;
      referenceResolution?: AutoRecallReferenceResolution;
      /** Memory's own `model_fallback` messages: a model call it ran on its backup provider. */
      fallbacks?: string[];
    }
  | {
      available: false;
      status: 'degraded' | 'unavailable';
      reason: 'missing-tool' | 'timeout' | 'error' | 'degraded' | 'unavailable';
      fallbacks?: string[];
    };

/** Skip retrieval for acknowledgements, including acks surrounded by punctuation or emoji. */
export function shouldRecall(userText: string): boolean {
  const text = userText
    .normalize('NFKC')
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .toLocaleLowerCase();
  return text.length > 0 && !TRIVIAL_REPLY_RE.test(text);
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * The two messages immediately before the current user turn, without runtime-injected blocks.
 * Akno applies its own tighter character cap; keeping the host bound small avoids sending a
 * transcript when only a pronoun needs resolving.
 */
export function recentAutoRecallConversation(
  history: ChatMessage[],
  currentUserIncluded = true,
): AutoRecallConversationTurn[] {
  const recent: AutoRecallConversationTurn[] = [];
  let skippedCurrentUser = !currentUserIncluded;

  for (let index = history.length - 1; index >= 0 && recent.length < 2; index -= 1) {
    const message = history[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;

    const raw = messageText(message).trim();
    if (!raw || isInjectedBlock(raw)) continue;
    if (!skippedCurrentUser && message.role === 'user') {
      skippedCurrentUser = true;
      continue;
    }

    const content = message.role === 'user' ? stripAttachmentAnnotations(unwrapUserText(raw)).trim() : raw;
    if (content) recent.push({ role: message.role, content: content.slice(0, 2_000) });
  }

  return recent.reverse();
}

const MEMORY_SERVER = 'memory';
const MEMORY_CONTEXT_TOOL = 'memory_context';

function escapeEvidence(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface ContextResultLike {
  type?: unknown;
  slug?: unknown;
  id?: unknown;
  quote?: unknown;
  lines?: unknown;
}

interface ObservationLike {
  status?: unknown;
  id?: unknown;
  level?: unknown;
  subject?: unknown;
  disposition?: unknown;
  proof_count?: unknown;
  evidence?: unknown;
}

const MEMORY_VIEWS = ['factual', 'history', 'planning', 'reports', 'questions', 'discussion', 'all'] as const;
type MemoryView = (typeof MEMORY_VIEWS)[number];

interface MemoryLike {
  status?: unknown;
  id?: unknown;
  level?: unknown;
  kind?: unknown;
  subject?: unknown;
  source_role?: unknown;
  source_speaker?: unknown;
  commitment?: unknown;
  disposition?: unknown;
  polarity?: unknown;
  basis?: unknown;
  answer_eligible?: unknown;
  current_eligible?: unknown;
}

interface ContextOutputLike {
  status?: unknown;
  results?: unknown;
  budget_used?: unknown;
  memory_view?: unknown;
  activation?: { selected?: unknown; qualification_run?: unknown; reference_resolution?: unknown };
  warnings?: unknown;
}

const REFERENCE_RESOLUTIONS = ['not_needed', 'resolved', 'ambiguous', 'unresolved'] as const;

function isReferenceResolution(value: unknown): value is AutoRecallReferenceResolution {
  return typeof value === 'string' && (REFERENCE_RESOLUTIONS as readonly string[]).includes(value);
}

function isMemoryView(value: unknown): value is MemoryView {
  return typeof value === 'string' && (MEMORY_VIEWS as readonly string[]).includes(value);
}

/**
 * Protocol v3 marks an L2 observation on the page line that carries its readable payload.
 *
 * It is still exact text from the knowledge base, but it is derived rather than authored fact.
 * Preserve that distinction in the deliberately flattened auto-recall block, together with the
 * leaf locators Akno says currently support it. An ineligible observation must fail closed: Akno
 * normally withholds it from context already, but injecting one if it ever crosses the boundary
 * would turn stale derived text back into apparent evidence.
 */
function renderContextLine(line: unknown, memoryView?: MemoryView): string | null {
  if (!line || typeof line !== 'object') return null;
  const value = line as { n?: unknown; text?: unknown; memory?: unknown; observation?: unknown };
  if (typeof value.n !== 'number' || typeof value.text !== 'string') return null;

  const qualifications: string[] = [];
  if (value.memory !== undefined) {
    if (!value.memory || typeof value.memory !== 'object') return null;
    const memory = value.memory as MemoryLike;
    // An unavailable or unfamiliar qualification must never fall through as an ordinary fact.
    if (memory.status !== 'qualified') return null;
    if (
      typeof memory.id !== 'string' ||
      !memory.id ||
      memory.level !== 1 ||
      typeof memory.kind !== 'string' ||
      !['claim', 'decision', 'preference', 'plan', 'event', 'question'].includes(memory.kind) ||
      typeof memory.subject !== 'string' ||
      !memory.subject ||
      typeof memory.source_role !== 'string' ||
      !['user', 'assistant', 'external', 'unknown'].includes(memory.source_role) ||
      (memory.source_speaker !== undefined && typeof memory.source_speaker !== 'string') ||
      typeof memory.commitment !== 'string' ||
      !['asserted', 'tentative', 'hypothetical', 'counterfactual', 'none'].includes(memory.commitment) ||
      typeof memory.disposition !== 'string' ||
      !['active', 'proposed', 'accepted', 'rejected', 'resolved', 'cancelled', 'completed', 'superseded'].includes(
        memory.disposition,
      ) ||
      typeof memory.polarity !== 'string' ||
      !['affirmed', 'negated'].includes(memory.polarity) ||
      typeof memory.basis !== 'string' ||
      !['self_attested', 'source_report', 'cited_evidence', 'system_record'].includes(memory.basis) ||
      typeof memory.answer_eligible !== 'boolean' ||
      typeof memory.current_eligible !== 'boolean'
    ) {
      return null;
    }

    // Contextual memories remain useful for an explicit history, plan, report or discussion view,
    // but crossing them into the default factual view would turn a proposal or report into a fact.
    if (
      (memoryView === undefined || memoryView === 'factual') &&
      (!memory.answer_eligible || !memory.current_eligible)
    ) {
      return null;
    }

    const source = memory.source_speaker
      ? `${memory.source_role} (${escapeEvidence(memory.source_speaker)})`
      : memory.source_role;
    qualifications.push(
      [
        'retained memory',
        `id ${escapeEvidence(memory.id)}`,
        `kind ${memory.kind}`,
        `subject ${escapeEvidence(memory.subject)}`,
        `source ${source}`,
        `commitment ${memory.commitment}`,
        `disposition ${memory.disposition}`,
        `polarity ${memory.polarity}`,
        `basis ${memory.basis}`,
        `answer eligible ${memory.answer_eligible ? 'yes' : 'no'}`,
        `current eligible ${memory.current_eligible ? 'yes' : 'no'}`,
      ].join('; '),
    );
  }

  if (value.observation !== undefined) {
    if (!value.observation || typeof value.observation !== 'object') return null;
    const observation = value.observation as ObservationLike;
    if (observation.status !== 'eligible') return null;
    if (
      typeof observation.id !== 'string' ||
      !observation.id ||
      observation.level !== 2 ||
      typeof observation.subject !== 'string' ||
      !observation.subject ||
      typeof observation.disposition !== 'string' ||
      !['active', 'weakened', 'retracted', 'superseded'].includes(observation.disposition) ||
      typeof observation.proof_count !== 'number' ||
      !Number.isInteger(observation.proof_count) ||
      observation.proof_count < 2 ||
      !Array.isArray(observation.evidence) ||
      observation.evidence.length < 2
    ) {
      return null;
    }

    const support = observation.evidence.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const evidence = entry as { slug?: unknown; line?: unknown };
      if (
        typeof evidence.slug !== 'string' ||
        !evidence.slug ||
        typeof evidence.line !== 'number' ||
        !Number.isInteger(evidence.line) ||
        evidence.line < 1
      ) {
        return [];
      }
      return [`${escapeEvidence(evidence.slug)}:${evidence.line}`];
    });
    if (support.length !== observation.evidence.length) return null;

    const details = [
      'derived observation',
      `id ${escapeEvidence(observation.id)}`,
      `subject ${escapeEvidence(observation.subject)}`,
      `${observation.proof_count} independent proofs`,
      `support ${support.join(', ')}`,
    ];
    qualifications.push(details.join('; '));
  }

  const qualification = qualifications.length > 0 ? ` [${qualifications.join('; ')}]` : '';
  return `${value.n}${qualification}: ${escapeEvidence(value.text)}`;
}

/** Render only exact evidence fields, never generated summaries or notes. */
export function buildAutoRecallEvidenceBlock(
  results: ContextResultLike[],
  status: 'ok' | 'empty' | 'degraded' = 'ok',
  memoryView?: MemoryView,
): string {
  const sections: string[] = [];

  for (const result of results) {
    if (result.type === 'page' && typeof result.slug === 'string' && Array.isArray(result.lines)) {
      const lines = result.lines.flatMap((line) => {
        const rendered = renderContextLine(line, memoryView);
        return rendered ? [rendered] : [];
      });
      if (lines.length > 0) {
        sections.push(`[evidence ${sections.length + 1}; page ${escapeEvidence(result.slug)}]\n${lines.join('\n')}`);
      }
      continue;
    }

    if (result.type === 'document' && typeof result.id === 'string' && typeof result.quote === 'string') {
      const quote = result.quote.trim();
      if (quote) {
        sections.push(
          `[evidence ${sections.length + 1}; document ${escapeEvidence(result.id)}]\n${escapeEvidence(quote)}`,
        );
      }
    }
  }

  if (sections.length === 0) return '';
  const statusAttribute = status === 'degraded' ? ' status="degraded"' : '';
  const memoryViewAttribute = memoryView ? ` memory_view="${memoryView}"` : '';
  return `<memory_evidence untrusted="true"${statusAttribute}${memoryViewAttribute}>\n${sections.join('\n\n')}\n</memory_evidence>`;
}

/**
 * The messages of memory's `model_fallback` warnings, deduplicated.
 *
 * Memory names the role, both providers and the reason itself, and says nothing about the query or
 * the knowledge base, so the message is the whole of what the user needs to hear. Anything without
 * a string message is dropped rather than guessed at.
 */
function fallbackMessages(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  const messages = warnings.flatMap((warning) => {
    const value = warning as { type?: unknown; message?: unknown } | null;
    return value?.type === 'model_fallback' && typeof value.message === 'string' && value.message
      ? [value.message]
      : [];
  });
  return [...new Set(messages)];
}

/**
 * Said apart from the evidence block. That block is quoted page data the agent must never take
 * direction from; this is the runtime telling it what happened to the call that fetched it.
 */
export function buildMemoryFallbackBlock(messages: string[]): string {
  if (messages.length === 0) return '';
  return `<memory_fallback>\n${messages.map((message) => escapeEvidence(message)).join('\n')}\n</memory_fallback>`;
}

function parseAutoRecallContext(raw: string): AutoRecallContext {
  if (isMcpError(raw)) return { available: false, status: 'unavailable', reason: 'error' };

  let parsed: ContextOutputLike;
  try {
    parsed = JSON.parse(raw) as ContextOutputLike;
  } catch {
    return { available: false, status: 'unavailable', reason: 'error' };
  }

  const fallbacks = fallbackMessages(parsed.warnings);
  const withFallbacks = fallbacks.length > 0 ? { fallbacks } : {};
  const status = parsed.status;
  if (status === 'unavailable') return { available: false, status, reason: 'unavailable', ...withFallbacks };
  if (status !== 'ok' && status !== 'empty' && status !== 'degraded') {
    return { available: false, status: 'unavailable', reason: 'error' };
  }
  if (parsed.memory_view !== undefined && !isMemoryView(parsed.memory_view)) {
    return { available: false, status: 'unavailable', reason: 'error' };
  }
  if (
    parsed.activation?.reference_resolution !== undefined &&
    !isReferenceResolution(parsed.activation.reference_resolution)
  ) {
    return { available: false, status: 'unavailable', reason: 'error' };
  }

  const memoryView = isMemoryView(parsed.memory_view) ? parsed.memory_view : undefined;
  const results = Array.isArray(parsed.results) ? (parsed.results as ContextResultLike[]) : [];
  const evidence = buildAutoRecallEvidenceBlock(results, status, memoryView);
  if (status === 'degraded' && !evidence) {
    return { available: false, status, reason: 'degraded', ...withFallbacks };
  }

  return {
    available: true,
    status,
    evidence,
    ...(memoryView ? { memoryView } : {}),
    selected:
      typeof parsed.activation?.selected === 'number' ? parsed.activation.selected : evidence ? results.length : 0,
    budgetUsed: typeof parsed.budget_used === 'number' ? parsed.budget_used : 0,
    qualificationRun: parsed.activation?.qualification_run === true,
    ...(isReferenceResolution(parsed.activation?.reference_resolution)
      ? { referenceResolution: parsed.activation.reference_resolution }
      : {}),
    ...withFallbacks,
  };
}

/** One hidden precision-first context call for an automatic host turn. */
export async function autoRecallContext(
  bridge: RecallBridge,
  query: string,
  conversationContext: AutoRecallConversationTurn[] = [],
  timeoutMs = DEFAULT_AUTO_RECALL_TIMEOUT_MS,
  budget = DEFAULT_AUTO_RECALL_BUDGET_TOKENS,
): Promise<AutoRecallContext> {
  if (!bridge.callRaw && !bridge.has(MEMORY_CONTEXT_TOOL)) {
    return { available: false, status: 'unavailable', reason: 'missing-tool' };
  }

  const args = {
    profile: 'auto_recall',
    query,
    budget,
    ...(conversationContext.length > 0 ? { conversation_context: conversationContext } : {}),
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.callRaw ? bridge.callRaw(MEMORY_SERVER, 'context', args) : bridge.call(MEMORY_CONTEXT_TOOL, args),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null) return { available: false, status: 'unavailable', reason: 'timeout' };
    return parseAutoRecallContext(result);
  } catch {
    return { available: false, status: 'unavailable', reason: 'error' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isMcpError(result: string): boolean {
  return /^(?:MCP tool error(?:\s|\()|MCP server not connected:|Unknown MCP tool:)/i.test(result.trim());
}

function isEmptyMemoryResult(result: string): boolean {
  return /^(?:\(?empty result\)?|\(?no results?\)?|no (?:matching )?facts(?: found)?|no memories found)[.!]?$/iu.test(
    result.trim(),
  );
}

/**
 * Call one memory tool, degrading instead of throwing.
 *
 * Used for pinned-page reads. Everything a caller must not get wrong lives
 * here: the timeout race, MCP-error sniffing, and memory's several spellings
 * of "nothing found".
 */
export async function callMemoryTool(
  bridge: RecallBridge,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_AUTO_RECALL_TIMEOUT_MS,
): Promise<HotMemoryRecall> {
  if (!bridge.has(toolName)) return { available: false, reason: 'missing-tool' };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.call(toolName, args),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null) return { available: false, reason: 'timeout' };
    if (isMcpError(result)) return { available: false, reason: 'error' };
    return {
      available: true,
      facts: isEmptyMemoryResult(result) ? '' : result,
    };
  } catch {
    return { available: false, reason: 'error' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** How the bridge exposes memory's `read` op: `<server display name>_<op>`. */
const MEMORY_READ_TOOL = 'memory_read';

/**
 * Strip YAML frontmatter so injection is body-only.
 *
 * Memory's `read` returns the page as stored, frontmatter and all. The agent has no use for a
 * page's `title:`/`type:` keys and they cost budget on every turn.
 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) return markdown;
  return markdown.slice(end + 4).replace(/^\r?\n+/, '');
}

export interface PinnedHotPage {
  slug: string;
  body: string;
}

/**
 * Load `users/shared` plus this speaker's own page, over the memory service.
 *
 * This used to read the two files off disk, from `LUNA_MEMORY_PATH`. That path is never set for a
 * container and the knowledge base is deliberately never mounted into one, so the function returned
 * `[]` every time and `<hot-memory>` had been silently empty since the memory backend was replaced.
 * Reading through the same relay the agent's own memory tools use is the only route that exists.
 *
 * A missing page is not an error — most installs have no `users/shared` — so both reads are allowed
 * to come back empty. Memory being unreachable is likewise not an error here: the turn proceeds
 * without hot memory rather than failing, which is what every other memory call in this file does.
 *
 * The slug comes from the host (`_luna.hotMemorySlug`), which resolves it from the configured roster.
 * It is not derived here from a platform handle any more: the page is named for the person's config
 * key, and the container has no way to know that mapping.
 */
export async function loadPinnedHotMemoryPages(
  bridge: RecallBridge,
  hotMemorySlug?: string | null,
  timeoutMs = DEFAULT_AUTO_RECALL_TIMEOUT_MS,
): Promise<PinnedHotPage[]> {
  const slugs = [
    HOT_MEMORY_SHARED_SLUG,
    ...(hotMemorySlug && hotMemorySlug !== HOT_MEMORY_SHARED_SLUG ? [hotMemorySlug] : []),
  ];

  const results = await Promise.all(
    slugs.map(async (slug) => {
      const result = await callMemoryTool(bridge, MEMORY_READ_TOOL, { slug }, timeoutMs);
      if (!result.available || !result.facts) return null;
      const body = stripFrontmatter(result.facts).trim();
      return body.length > 0 ? { slug, body } : null;
    }),
  );
  return results.filter((page): page is PinnedHotPage => page !== null);
}

/**
 * Format pinned hot-memory pages for the system prompt.
 * Missing pages are omitted silently.
 */
export function buildHotMemoryBlock(pages: PinnedHotPage[], budgetChars = DEFAULT_HOT_MEMORY_BUDGET_CHARS): string {
  if (pages.length === 0 || budgetChars <= 0) return '';

  const sections: string[] = [];
  let used = 0;
  for (const page of pages) {
    const header = `### ${page.slug}\n`;
    const remaining = budgetChars - used - header.length;
    if (remaining <= 0) {
      sections.push('… [hot memory truncated]');
      break;
    }
    let body = page.body;
    if (body.length > remaining) {
      const lineBreak = body.lastIndexOf('\n', remaining);
      body = (lineBreak > 0 ? body.slice(0, lineBreak) : body.slice(0, remaining)) + '\n… [hot memory truncated]';
      sections.push(`${header}${body}`);
      break;
    }
    sections.push(`${header}${body}`);
    used += header.length + body.length + 2;
  }

  if (sections.length === 0) return '';
  return `<hot-memory>\n${sections.join('\n\n')}\n</hot-memory>`;
}
