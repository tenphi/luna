/**
 * Tool emoji + verb-aware label + summary heuristics for the live progress
 * message.
 *
 * Tool names arrive from the agent-runner already resolved to their canonical
 * exposed form (see `container/.../tools/tool-aliases.ts` — `DOMAIN_ALIASES`):
 *   - Domain-prefixed MCP: `get_memory_page`, `list_calendar_events`, `web_search`, …
 *   - Server-prefixed fallback for uncurated tools: `email_read_message`,
 *     `tavily_tavily_research`, `vulpine_list_payments`, …
 *   - Legacy MCP `mcp__{server}__{tool}` (still accepted during cutover).
 *   - Built-ins: PascalCase (`Bash`, `Read`, …) plus `edit_memory_page`.
 *
 * Each tool resolves to a { emoji, activeLabel, doneLabel, summary }:
 *   - `activeLabel` is present-progressive ("Reading skill", "Searching") and
 *     is shown while the tool is running.
 *   - `doneLabel` is past-tense ("Skill used", "Searched") and is shown once
 *     the tool completes (frozen line + collapsed "Done" summary).
 *   - `summary` is a concise one-liner extracted from the args.
 *
 * Labels come from a small descriptor registry; anything not explicitly listed
 * falls back to a generic verb derivation (operation token → verb pair) plus a
 * smart single-arg summary, so unknown/new tools still read cleanly instead of
 * dumping raw `key=value` pairs.
 */

export interface ToolSummary {
  emoji: string;
  /** Present-progressive label shown while the tool is running. */
  activeLabel: string;
  /** Past-tense label shown once the tool completes. */
  doneLabel: string;
  /** Optional one-liner. Empty string → don't show. */
  summary: string;
}

const GENERIC_MCP_EMOJI = '🔧';

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

const MEMORY_EMOJI = '🧠';
const CALENDAR_EMOJI = '📅';
const NOTES_EMOJI = '📝';
const REMINDERS_EMOJI = '⏰';
const CONTACTS_EMOJI = '👤';
const EMAIL_EMOJI = '✉️';
const WEB_EMOJI = '🌐';
const IMESSAGE_EMOJI = '💬';

/** Raw memory tool names — brain emoji even if the server segment is wrong (legacy). */
const MEMORY_RAW_TOOLS = new Set([
  'search',
  'query',
  'get_page',
  'put_page',
  'delete_page',
  'list_pages',
  'resolve_slugs',
  'recall',
  'forget_fact',
  'add_link',
  'remove_link',
  'get_links',
  'get_backlinks',
  'traverse_graph',
  'get_timeline',
  'get_recent_salience',
  'find_anomalies',
  'find_trajectory',
  'think',
  'get_tags',
  'add_tag',
  'remove_tag',
]);

/** Server segment (legacy `mcp__server__tool` form) → emoji. */
const SERVER_EMOJI: Record<string, string> = {
  memory: MEMORY_EMOJI,
  apple_calendar: CALENDAR_EMOJI,
  apple_notes: NOTES_EMOJI,
  apple_reminders: REMINDERS_EMOJI,
  apple_contacts: CONTACTS_EMOJI,
  apple_messages: IMESSAGE_EMOJI,
  email: EMAIL_EMOJI,
  tavily: WEB_EMOJI,
  web: WEB_EMOJI,
  search: WEB_EMOJI,
  browser: WEB_EMOJI,
  gcal: CALENDAR_EMOJI,
  gmail: EMAIL_EMOJI,
  vulpine: '💳',
  linear: '📋',
  github: '🐙',
};

/**
 * Resolve an emoji from a canonical exposed tool name via keyword scan.
 * Order matters: more specific domains are checked before generic servers.
 */
function resolveEmoji(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('email')) return EMAIL_EMOJI;
  if (lower.startsWith('web') || lower.startsWith('tavily') || lower.includes('research')) return WEB_EMOJI;
  if (lower.includes('imessage')) return IMESSAGE_EMOJI;
  if (lower.includes('memory')) return MEMORY_EMOJI;
  if (lower.includes('calendar')) return CALENDAR_EMOJI;
  if (lower.includes('reminder')) return REMINDERS_EMOJI;
  if (lower.includes('contact')) return CONTACTS_EMOJI;
  if (lower.includes('note')) return NOTES_EMOJI;
  const server = lower.split('_')[0] ?? '';
  return SERVER_EMOJI[server] ?? GENERIC_MCP_EMOJI;
}

// ---------------------------------------------------------------------------
// Verb pairs (operation token → present/past)
// ---------------------------------------------------------------------------

interface VerbPair {
  active: string;
  done: string;
}

const VERB_BY_OP: Record<string, VerbPair> = {
  get: { active: 'Reading', done: 'Read' },
  read: { active: 'Reading', done: 'Read' },
  fetch: { active: 'Fetching', done: 'Fetched' },
  list: { active: 'Listing', done: 'Listed' },
  search: { active: 'Searching', done: 'Searched' },
  query: { active: 'Searching', done: 'Searched' },
  find: { active: 'Searching', done: 'Searched' },
  create: { active: 'Creating', done: 'Created' },
  add: { active: 'Adding', done: 'Added' },
  update: { active: 'Updating', done: 'Updated' },
  edit: { active: 'Editing', done: 'Edited' },
  delete: { active: 'Deleting', done: 'Deleted' },
  remove: { active: 'Removing', done: 'Removed' },
  put: { active: 'Saving', done: 'Saved' },
  download: { active: 'Downloading', done: 'Downloaded' },
  send: { active: 'Sending', done: 'Sent' },
  reply: { active: 'Replying', done: 'Replied' },
  forward: { active: 'Forwarding', done: 'Forwarded' },
  complete: { active: 'Completing', done: 'Completed' },
  uncomplete: { active: 'Updating', done: 'Updated' },
  move: { active: 'Moving', done: 'Moved' },
  append: { active: 'Appending', done: 'Appended' },
  resolve: { active: 'Resolving', done: 'Resolved' },
  traverse: { active: 'Exploring', done: 'Explored' },
  think: { active: 'Thinking', done: 'Thought' },
  recall: { active: 'Recalling', done: 'Recalled' },
  forget: { active: 'Forgetting', done: 'Forgot' },
  crawl: { active: 'Crawling', done: 'Crawled' },
  extract: { active: 'Extracting', done: 'Extracted' },
  map: { active: 'Mapping', done: 'Mapped' },
  research: { active: 'Researching', done: 'Researched' },
};

const DEFAULT_VERB: VerbPair = { active: 'Running', done: 'Ran' };

/** Leading domain/server tokens that are not operations — stripped for verb derivation. */
const DOMAIN_STRIP = new Set(['email', 'web', 'vulpine', 'linear', 'github', 'gcal', 'gmail']);

/** Split a canonical tool name into { op, noun } for generic verb derivation. */
function splitOpNoun(name: string): { op: string; noun: string } {
  // tavily_tavily_research → research (collapse repeated tavily_ prefix)
  const n = name.replace(/^(tavily_)+/, '');
  const tokens = n.split('_').filter(Boolean);
  if (tokens.length === 0) return { op: name.toLowerCase(), noun: '' };
  if (tokens.length > 1 && DOMAIN_STRIP.has(tokens[0]!.toLowerCase())) {
    tokens.shift();
  }
  const op = tokens[0]!.toLowerCase();
  const noun = tokens.slice(1).join(' ').toLowerCase();
  return { op, noun };
}

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

function compactValue(value: unknown, maxLen = 60): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const s = value.replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const inner = value
      .map((v) => compactValue(v, 20))
      .filter(Boolean)
      .join(', ');
    return inner.length > maxLen ? `${inner.slice(0, maxLen - 1)}…` : inner;
  }
  const s = JSON.stringify(value);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function compactArgs(args: Record<string, unknown>, maxLen = 80): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const v = compactValue(value, 40);
    if (v === '') continue;
    parts.push(`${key}=${v}`);
  }
  const joined = parts.join(' · ');
  return joined.length > maxLen ? `${joined.slice(0, maxLen - 1)}…` : joined;
}

/** Preferred arg keys for the smart generic summary, in priority order. */
const PREFERRED_SUMMARY_KEYS = [
  'query',
  'q',
  'input',
  'title',
  'subject',
  'name',
  'slug',
  'path',
  'file',
  'url',
  'pattern',
  'command',
  'text',
  'to',
  'id',
];

/** Smart generic summary: pick a single meaningful arg rather than dumping all. */
function genericSummary(args: Record<string, unknown>): string {
  for (const key of PREFERRED_SUMMARY_KEYS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) return compactValue(v, 60);
    if (typeof v === 'number') return String(v);
  }
  return compactArgs(args);
}

type SummaryExtractor = (args: Record<string, unknown>) => string;

function str(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

const slugSummary: SummaryExtractor = (a) => str(a, 'slug', 'title', 'path');

/**
 * What a partial page edit wrote, as one readable line.
 *
 * A raw `new_string=… · old_string=…` pair reads as machine noise: both sides
 * open with the same field label, so 40 chars of each showed the label twice and
 * clipped away the only part that differed. The first line of the new text is
 * the fact that was stored, which is what the owner is checking for.
 */
function editedLineSummary(newString: string, oldString: string): string {
  const firstLine = (text: string): string =>
    (text.split('\n').find((line) => line.trim().length > 0) ?? '')
      // Markdown scaffolding around the value — bullets, bold, headings.
      .replace(/^[\s>#*-]+/, '')
      .replace(/\*\*/g, '')
      .trim();

  const written = firstLine(newString);
  if (written) return compactValue(written, 60);
  // An edit to empty text is a removal; name what left rather than nothing.
  const removed = firstLine(oldString);
  return removed ? `removed ${compactValue(removed, 50)}` : '';
}
const querySummary: SummaryExtractor = (a) => {
  const q = str(a, 'query', 'q', 'input');
  return q ? `"${compactValue(q, 58)}"` : '';
};

// ---------------------------------------------------------------------------
// Descriptor registry (keyed on canonical exposed names)
// ---------------------------------------------------------------------------

interface ToolDescriptor {
  emoji?: string;
  /** Full active-label override (present progressive). */
  active?: string;
  /** Full done-label override (past tense). */
  done?: string;
  summary?: SummaryExtractor;
}

const MEMORY_DESCRIPTORS: Record<string, ToolDescriptor> = {
  search_memory: { summary: querySummary },
  query_memory: { summary: querySummary },
  get_memory_page: { summary: slugSummary },
  put_memory_page: { active: 'Memorizing', done: 'Remembered', summary: slugSummary },
  edit_memory_page: {
    active: 'Updating memory',
    done: 'Memory updated',
    summary: (a) => {
      const slug = str(a, 'slug');
      const written = editedLineSummary(str(a, 'new_string'), str(a, 'old_string'));
      return [slug, written].filter(Boolean).join(' · ');
    },
  },
  delete_memory_page: { active: 'Forgetting page', done: 'Page forgotten', summary: slugSummary },
  list_memory_pages: { summary: () => 'All pages' },
  resolve_memory_slugs: {
    summary: (a) => {
      const partial = str(a, 'partial');
      return partial ? `"${partial}"` : '';
    },
  },
  recall_memory: { summary: (a) => str(a, 'text', 'query', 'entity') },
  forget_memory_fact: { summary: (a) => str(a, 'text', 'fact', 'id') },
  add_memory_link: {
    summary: (a) => [str(a, 'from', 'source', 'slug'), str(a, 'to', 'target')].filter(Boolean).join(' → '),
  },
  remove_memory_link: {
    summary: (a) => [str(a, 'from', 'source', 'slug'), str(a, 'to', 'target')].filter(Boolean).join(' → '),
  },
  get_memory_links: { summary: slugSummary },
  get_memory_backlinks: { summary: slugSummary },
  traverse_memory_graph: {
    active: 'Exploring memory',
    done: 'Explored memory',
    summary: (a) => str(a, 'slug', 'start', 'entity'),
  },
  get_memory_timeline: { summary: slugSummary },
  read_timeline: {
    active: 'Checking the timeline',
    done: 'Timeline checked',
    // Show the filter, since that is the whole point of the call — an unfiltered
    // one is the mistake we want visible in the progress line.
    summary: (a) => {
      const span = [str(a, 'since'), str(a, 'until')].filter(Boolean).join('..');
      return [span, str(a, 'match')].filter(Boolean).join(' · ') || 'recent events';
    },
  },
  get_memory_salience: {
    active: 'Checking salience',
    done: 'Salience checked',
    summary: (a) => str(a, 'slugPrefix', 'kind') || 'What\u2019s notable',
  },
  find_memory_anomalies: { summary: () => 'Anomalies' },
  find_memory_trajectory: { summary: (a) => str(a, 'entity', 'slug', 'query') },
  think_memory: { summary: querySummary },
  get_memory_tags: { summary: slugSummary },
  add_memory_tag: { summary: (a) => [str(a, 'slug', 'path'), str(a, 'tag')].filter(Boolean).join(' · ') },
  remove_memory_tag: { summary: (a) => [str(a, 'slug', 'path'), str(a, 'tag')].filter(Boolean).join(' · ') },
};

const CALENDAR_DESCRIPTORS: Record<string, ToolDescriptor> = {
  list_calendar_events: {
    summary: (a) => {
      const from = str(a, 'from_date', 'start', 'startDate', 'from');
      const to = str(a, 'to_date', 'end', 'endDate', 'to');
      if (from && to) return `${from} – ${to}`;
      if (from) return `from ${from}`;
      if (to) return `until ${to}`;
      return '';
    },
  },
  search_calendar_events: { summary: querySummary },
  get_calendar_event: { summary: (a) => str(a, 'title', 'summary', 'uid', 'eventId', 'id') },
  create_calendar_event: { summary: (a) => str(a, 'title', 'summary', 'name') },
  update_calendar_event: { summary: (a) => str(a, 'title', 'summary', 'uid', 'eventId', 'id') },
  delete_calendar_event: { summary: (a) => str(a, 'title', 'uid', 'eventId', 'id') },
};

const REMINDERS_DESCRIPTORS: Record<string, ToolDescriptor> = {
  list_reminders: {
    summary: (a) => {
      const on = str(a, 'completed_on');
      if (on) return `completed ${on}`;
      const from = str(a, 'completed_from');
      const to = str(a, 'completed_to');
      if (from && to) return `completed ${from} – ${to}`;
      if (from) return `completed since ${from}`;
      if (to) return `completed until ${to}`;
      return '';
    },
  },
  get_reminder: { summary: (a) => str(a, 'title', 'uid', 'id') },
  create_reminder: { summary: (a) => str(a, 'title', 'name') },
  update_reminder: { summary: (a) => str(a, 'title', 'name', 'uid', 'id') },
  complete_reminder: {
    active: 'Completing reminder',
    done: 'Reminder completed',
    summary: (a) => str(a, 'title', 'uid', 'reminderId', 'id'),
  },
  uncomplete_reminder: { summary: (a) => str(a, 'title', 'uid', 'reminderId', 'id') },
  delete_reminder: { summary: (a) => str(a, 'title', 'uid', 'reminderId', 'id') },
  search_reminders: { summary: querySummary },
};

const NOTES_DESCRIPTORS: Record<string, ToolDescriptor> = {
  list_notes: { summary: () => '' },
  list_note_folders: { summary: () => '' },
  get_note: { summary: (a) => str(a, 'title', 'noteId', 'id') },
  create_note: { summary: (a) => str(a, 'title', 'name') },
  create_note_folder: { summary: (a) => str(a, 'name', 'title') },
  update_note: { summary: (a) => str(a, 'title', 'noteId', 'id') },
  append_to_note: { summary: (a) => str(a, 'title', 'noteId', 'id') },
  move_note: { summary: (a) => str(a, 'title', 'noteId', 'id') },
  delete_note: { summary: (a) => str(a, 'title', 'noteId', 'id') },
  delete_note_folder: { summary: (a) => str(a, 'name', 'title') },
  search_notes: { summary: querySummary },
};

const CONTACTS_DESCRIPTORS: Record<string, ToolDescriptor> = {
  list_contacts: { summary: () => '' },
  list_contact_groups: { summary: () => '' },
  get_contact: { summary: (a) => str(a, 'name', 'id') },
  search_contacts: { summary: querySummary },
  create_contact: { summary: (a) => str(a, 'name', 'firstName', 'first_name') },
  update_contact: { summary: (a) => str(a, 'name', 'id') },
  delete_contact: { summary: (a) => str(a, 'name', 'id') },
  create_contact_group: { summary: (a) => str(a, 'name', 'group') },
  delete_contact_group: { summary: (a) => str(a, 'name', 'group') },
  add_contact_to_group: { summary: (a) => [str(a, 'name', 'contact'), str(a, 'group')].filter(Boolean).join(' → ') },
  remove_contact_from_group: {
    summary: (a) => [str(a, 'name', 'contact'), str(a, 'group')].filter(Boolean).join(' → '),
  },
};

const IMESSAGE_DESCRIPTORS: Record<string, ToolDescriptor> = {
  list_imessage_chats: { summary: () => '' },
  get_imessage_chat_messages: {
    active: 'Reading messages',
    done: 'Messages read',
    summary: (a) => str(a, 'chat', 'chatId', 'id'),
  },
  search_imessages: { summary: querySummary },
  send_imessage: { summary: (a) => str(a, 'to', 'recipient', 'chat') },
  get_imessage_chat_participants: { summary: (a) => str(a, 'chat', 'chatId', 'id') },
};

/** Email tools arrive server-prefixed (`email_*`). */
const EMAIL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  email_list_accounts: { summary: () => '' },
  email_list_folders: { summary: () => '' },
  email_list_envelopes: {
    active: 'Listing envelopes',
    done: 'Envelopes listed',
    summary: (a) => {
      const days = [str(a, 'since'), str(a, 'until')].filter(Boolean);
      const parts = [
        str(a, 'folder') && `folder=${str(a, 'folder')}`,
        str(a, 'from') && `from=${str(a, 'from')}`,
        str(a, 'subject') && `subject=${str(a, 'subject')}`,
        // `query` used to be printed as `subject=`, which read as a search of the subject line
        // for a date range when the agent had in fact asked for one.
        str(a, 'query', 'q') && `query=${str(a, 'query', 'q')}`,
        days.length > 0 && `days=${days.join('..')}`,
        str(a, 'page') && `page=${str(a, 'page')}`,
        str(a, 'pageSize', 'page_size') && `pageSize=${str(a, 'pageSize', 'page_size')}`,
      ].filter(Boolean);
      return parts.join(' · ');
    },
  },
  email_read_message: {
    active: 'Reading message',
    done: 'Message read',
    summary: (a) => {
      const subject = str(a, 'subject');
      if (subject) return subject;
      const id = str(a, 'id', 'messageId', 'message_id');
      return id ? `id=${id}` : '';
    },
  },
  email_download_attachments: { summary: (a) => str(a, 'id', 'messageId', 'message_id') },
  // Curated/legacy email names (if ever exposed non-prefixed).
  send_email: { summary: (a) => str(a, 'to', 'subject') },
  reply_email: { summary: (a) => str(a, 'to', 'subject') },
  forward_email: { summary: (a) => str(a, 'to', 'subject') },
  read_email: { active: 'Reading message', done: 'Message read', summary: (a) => str(a, 'subject', 'messageId', 'id') },
  list_emails: { summary: querySummary },
  delete_email: { summary: (a) => str(a, 'subject', 'messageId', 'id') },
};

/** Web / research tools (`web_*`, `tavily_*`). */
const WEB_DESCRIPTORS: Record<string, ToolDescriptor> = {
  web_search: { summary: querySummary },
  web_extract: { summary: (a) => str(a, 'url', 'urls') },
  web_crawl: { summary: (a) => str(a, 'url', 'startUrl') },
  web_map: { summary: (a) => str(a, 'url', 'startUrl') },
  research: { emoji: WEB_EMOJI, active: 'Researching', done: 'Researched', summary: querySummary },
  tavily_research: { emoji: WEB_EMOJI, active: 'Researching', done: 'Researched', summary: querySummary },
  tavily_tavily_research: { emoji: WEB_EMOJI, active: 'Researching', done: 'Researched', summary: querySummary },
};

const BUILTIN_DESCRIPTORS: Record<string, ToolDescriptor> = {
  Bash: {
    emoji: '⚙️',
    active: 'Running',
    done: 'Ran',
    summary: (a) => compactValue(str(a, 'command', 'cmd'), 60),
  },
  Read: { emoji: '🔎', active: 'Reading', done: 'Read', summary: (a) => str(a, 'path', 'file') },
  Write: { emoji: '✏️', active: 'Writing', done: 'Wrote', summary: (a) => str(a, 'path', 'file') },
  Edit: { emoji: '✏️', active: 'Editing', done: 'Edited', summary: (a) => str(a, 'path', 'file') },
  Glob: { emoji: '🔎', active: 'Searching', done: 'Searched', summary: (a) => str(a, 'pattern', 'glob_pattern') },
  Grep: {
    emoji: '🔎',
    active: 'Searching',
    done: 'Searched',
    summary: (a) => {
      const p = str(a, 'pattern');
      return p ? `/${p}/` : '';
    },
  },
  Skill: {
    emoji: '📦',
    active: 'Reading skill',
    done: 'Skill used',
    summary: (a) => str(a, 'name', 'skill', 'command'),
  },
  edit_memory_page: MEMORY_DESCRIPTORS.edit_memory_page!,
  edit_page: MEMORY_DESCRIPTORS.edit_memory_page!,
};

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  ...MEMORY_DESCRIPTORS,
  ...CALENDAR_DESCRIPTORS,
  ...REMINDERS_DESCRIPTORS,
  ...NOTES_DESCRIPTORS,
  ...CONTACTS_DESCRIPTORS,
  ...IMESSAGE_DESCRIPTORS,
  ...EMAIL_DESCRIPTORS,
  ...WEB_DESCRIPTORS,
  ...BUILTIN_DESCRIPTORS,
};

/** Raw memory tool name → canonical exposed name (for the legacy mcp__ path). */
const MEMORY_RAW_TO_CANONICAL: Record<string, string> = {
  search: 'search_memory',
  query: 'query_memory',
  get_page: 'get_memory_page',
  put_page: 'put_memory_page',
  delete_page: 'delete_memory_page',
  list_pages: 'list_memory_pages',
  resolve_slugs: 'resolve_memory_slugs',
  recall: 'recall_memory',
  forget_fact: 'forget_memory_fact',
  add_link: 'add_memory_link',
  remove_link: 'remove_memory_link',
  get_links: 'get_memory_links',
  get_backlinks: 'get_memory_backlinks',
  traverse_graph: 'traverse_memory_graph',
  get_timeline: 'get_memory_timeline',
  get_recent_salience: 'get_memory_salience',
  find_anomalies: 'find_memory_anomalies',
  find_trajectory: 'find_memory_trajectory',
  think: 'think_memory',
  get_tags: 'get_memory_tags',
  add_tag: 'add_memory_tag',
  remove_tag: 'remove_memory_tag',
};

// ---------------------------------------------------------------------------
// Name prettification (kept for tests / external callers)
// ---------------------------------------------------------------------------

/** "put_page" → "Put page", "list_calendar_events" → "List calendar events" */
export function prettifyToolName(rawName: string): string {
  const parts = rawName.split('_');
  if (parts.length === 0) return rawName;
  parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Label + summary resolution
// ---------------------------------------------------------------------------

/** Uppercase the first character of a label. */
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Resolve active/done labels for a canonical name, honoring descriptor overrides. */
function resolveLabels(name: string, desc: ToolDescriptor | undefined): { activeLabel: string; doneLabel: string } {
  const { op, noun } = splitOpNoun(name);
  const verb = VERB_BY_OP[op] ?? DEFAULT_VERB;
  const compose = (v: string): string => cap(noun ? `${v} ${noun}` : v);
  return {
    activeLabel: desc?.active ?? compose(verb.active),
    doneLabel: desc?.done ?? compose(verb.done),
  };
}

function summarizeCanonical(name: string, args: Record<string, unknown>): ToolSummary {
  const desc = DESCRIPTORS[name];
  const emoji = desc?.emoji ?? resolveEmoji(name);
  const { activeLabel, doneLabel } = resolveLabels(name, desc);
  const summary = desc?.summary ? desc.summary(args) : genericSummary(args);
  return { emoji, activeLabel, doneLabel, summary };
}

/** Legacy `mcp__server__tool` form (accepted during cutover). */
function summarizeLegacy(rawName: string, args: Record<string, unknown>): ToolSummary {
  const rest = rawName.slice(5);
  const sep = rest.indexOf('__');
  const server = sep >= 0 ? rest.slice(0, sep) : rest;
  const toolRaw = sep >= 0 ? rest.slice(sep + 2) : '';

  // Memory tools keep the brain emoji even if the server segment is wrong.
  const isMemory =
    server === 'memory' ||
    toolRaw.includes('memory') ||
    (MEMORY_RAW_TOOLS.has(toolRaw) && toolRaw !== 'search') ||
    (toolRaw === 'search' && server === 'memory');

  if (!toolRaw) {
    // Server-only name: derive from the server token.
    const emoji = isMemory ? MEMORY_EMOJI : (SERVER_EMOJI[server] ?? GENERIC_MCP_EMOJI);
    const { activeLabel, doneLabel } = resolveLabels(server, DESCRIPTORS[server]);
    return { emoji, activeLabel, doneLabel, summary: genericSummary(args) };
  }

  // Map known raw names to their canonical exposed form for nicer labels/summaries.
  const canonical = isMemory ? (MEMORY_RAW_TO_CANONICAL[toolRaw] ?? toolRaw) : toolRaw;
  const desc = DESCRIPTORS[canonical];
  const emoji = desc?.emoji ?? (isMemory ? MEMORY_EMOJI : (SERVER_EMOJI[server] ?? resolveEmoji(canonical)));
  const { activeLabel, doneLabel } = resolveLabels(canonical, desc);
  const summary = desc?.summary ? desc.summary(args) : genericSummary(args);
  return { emoji, activeLabel, doneLabel, summary };
}

/**
 * Parse a tool name (from the OpenAI provider event) into
 * { emoji, activeLabel, doneLabel, summary } for the progress message.
 */
export function summarizeTool(rawName: string, args: Record<string, unknown>): ToolSummary {
  if (rawName.startsWith('mcp__')) return summarizeLegacy(rawName, args);
  return summarizeCanonical(rawName, args);
}
