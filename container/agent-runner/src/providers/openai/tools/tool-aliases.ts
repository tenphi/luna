/**
 * Domain-prefixed tool names for the OpenAI provider tool surface.
 *
 * MCP servers still use raw names internally (`get_page`, `list_events`).
 * The agent sees short domain names (`get_memory_page`, `list_calendar_events`)
 * instead of the Claude-SDK `mcp__server__tool` scheme.
 *
 * Dispatch also accepts legacy `mcp__…` names and a few historical aliases
 * (`edit_page`, `ask_user_question`) so in-flight sessions keep working.
 */

/** Mirror the SDK's prefix sanitization: anything outside [A-Za-z0-9_-] → '_'. */
export function sanitizeToolSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Legacy Claude-SDK style name (kept for dispatch compatibility). */
export function legacyMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(toolName)}`;
}

export function parseLegacyMcpToolName(
  name: string,
): { serverSegment: string; toolSegment: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  return { serverSegment: m[1]!, toolSegment: m[2]! };
}

/**
 * Curated exposed names per MCP server → raw tool.
 * apple_messages is intentionally absent (unsupported / messages.enabled off).
 */
export const DOMAIN_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  apple_calendar: {
    list_events: 'list_calendar_events',
    search_events: 'search_calendar_events',
    get_event: 'get_calendar_event',
    create_event: 'create_calendar_event',
    update_event: 'update_calendar_event',
    delete_event: 'delete_calendar_event',
  },
  apple_reminders: {
    list_reminders: 'list_reminders',
    get_reminder: 'get_reminder',
    create_reminder: 'create_reminder',
    update_reminder: 'update_reminder',
    complete_reminder: 'complete_reminder',
    uncomplete_reminder: 'uncomplete_reminder',
    delete_reminder: 'delete_reminder',
    search_reminders: 'search_reminders',
  },
  apple_notes: {
    list_folders: 'list_note_folders',
    create_folder: 'create_note_folder',
    list_notes: 'list_notes',
    get_note: 'get_note',
    create_note: 'create_note',
    update_note: 'update_note',
    move_note: 'move_note',
    append_to_note: 'append_to_note',
    delete_note: 'delete_note',
    delete_folder: 'delete_note_folder',
    search_notes: 'search_notes',
  },
  apple_contacts: {
    list_groups: 'list_contact_groups',
    list_contacts: 'list_contacts',
    get_contact: 'get_contact',
    search_contacts: 'search_contacts',
    create_contact: 'create_contact',
    update_contact: 'update_contact',
    delete_contact: 'delete_contact',
    create_group: 'create_contact_group',
    delete_group: 'delete_contact_group',
    add_contact_to_group: 'add_contact_to_group',
    remove_contact_from_group: 'remove_contact_from_group',
  },
  apple_messages: {
    list_chats: 'list_imessage_chats',
    get_chat_messages: 'get_imessage_chat_messages',
    search_messages: 'search_imessages',
    send_message: 'send_imessage',
    get_chat_participants: 'get_imessage_chat_participants',
  },
  tavily: {
    search: 'web_search',
    tavily_search: 'web_search',
    extract: 'web_extract',
    tavily_extract: 'web_extract',
    crawl: 'web_crawl',
    tavily_crawl: 'web_crawl',
    map: 'web_map',
    tavily_map: 'web_map',
  },
  luna: {
    send_message: 'send_message',
    send_file: 'send_file',
    edit_message: 'edit_message',
    add_reaction: 'add_reaction',
    ask_user_question: 'ask_question',
    send_card: 'send_card',
    schedule_task: 'schedule_task',
    list_tasks: 'list_tasks',
    cancel_task: 'cancel_task',
    pause_task: 'pause_task',
    resume_task: 'resume_task',
    update_task: 'update_task',
    create_agent: 'create_agent',
    install_packages: 'install_packages',
    add_mcp_server: 'add_mcp_server',
    manage_skill: 'manage_skill',
  },
};

/** Builtin / invented names that resolve to a canonical exposed tool. */
const CALL_ALIASES: Readonly<Record<string, string>> = {
  ask_user_question: 'ask_question',
};

/** Luna chat tools that deliver user-facing output mid-turn. */
export const USER_FACING_SEND_TOOLS = new Set([
  'send_message',
  'send_file',
  'send_card',
  'ask_question',
  // Legacy exposed / raw names still accepted via resolve.
  'ask_user_question',
]);

/** Luna plumbing tools — progress UI should not surface these. */
export const LUNA_PROGRESS_HIDDEN_TOOLS = new Set([
  'send_message',
  'send_file',
  'edit_message',
  'add_reaction',
  'ask_question',
  'ask_user_question',
  'send_card',
  'schedule_task',
  'list_tasks',
  'cancel_task',
  'pause_task',
  'resume_task',
  'update_task',
  'create_agent',
  'install_packages',
  'add_mcp_server',
  'manage_skill',
]);

/**
 * How a bridged server is named to the agent.
 *
 * There is nothing to rename now that the memory server registers under `memory`, but the
 * seam stays: a backend's own name is an implementation detail the model has no use for, and
 * this is the one place that decides what it is called instead.
 */
export function serverDisplayName(serverName: string): string {
  return serverName;
}

/** Name the agent sees for a bridged MCP tool. */
export function exposeToolName(serverName: string, toolName: string): string {
  const curated = DOMAIN_ALIASES[serverName]?.[toolName];
  if (curated) return curated;
  // Uncurated tool (a custom `toolsAllow` naming an op the alias map does not cover).
  return `${sanitizeToolSegment(serverDisplayName(serverName))}_${sanitizeToolSegment(toolName)}`;
}

/**
 * Normalize a model-called name to the canonical exposed name when known.
 * Returns the input unchanged when it is already canonical or unknown.
 */
export function resolveToolName(called: string): string {
  if (CALL_ALIASES[called]) return CALL_ALIASES[called]!;
  const legacy = parseLegacyMcpToolName(called);
  if (legacy) {
    // Prefer curated map keyed by the unsanitized server name when segments match.
    for (const [server, tools] of Object.entries(DOMAIN_ALIASES)) {
      if (sanitizeToolSegment(server) !== legacy.serverSegment) continue;
      for (const [raw, exposed] of Object.entries(tools)) {
        if (sanitizeToolSegment(raw) === legacy.toolSegment) return exposed;
      }
      // Unknown raw tool on a known server → mechanical fallback. Must match
      // `exposeToolName`'s fallback, display name included, or a legacy call
      // would normalize to a name that was never advertised.
      return mechanicalExposedName(legacy.serverSegment, legacy.toolSegment);
    }
    return mechanicalExposedName(legacy.serverSegment, legacy.toolSegment);
  }
  return called;
}

/** The `exposeToolName` fallback, keyed by an already-sanitized server segment. */
function mechanicalExposedName(serverSegment: string, toolSegment: string): string {
  return `${serverSegment}_${toolSegment}`;
}

/** True when `name` is a luna chat/plumbing tool (new or legacy mcp__ form). */
export function isLunaProgressHiddenTool(name: string): boolean {
  if (LUNA_PROGRESS_HIDDEN_TOOLS.has(name)) return true;
  const legacy = parseLegacyMcpToolName(name);
  if (legacy?.serverSegment === 'luna') return true;
  const resolved = resolveToolName(name);
  return LUNA_PROGRESS_HIDDEN_TOOLS.has(resolved);
}

export function isUserFacingSendToolName(name: string): boolean {
  const resolved = resolveToolName(name);
  if (USER_FACING_SEND_TOOLS.has(resolved) || USER_FACING_SEND_TOOLS.has(name)) return true;
  const legacy = parseLegacyMcpToolName(name);
  return legacy?.serverSegment === 'luna' && USER_FACING_SEND_TOOLS.has(legacy.toolSegment);
}
