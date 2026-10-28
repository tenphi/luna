import type { ChatMessage } from './types.js';
import type { RecallBridge } from './auto-recall.js';
import {
  calendarAgendaInsertIndex,
  calendarAgendaWindow,
  compactEventTime,
} from './auto-calendar.js';

/** Match calendar agenda horizon — dated reminders beyond this are noise for auto-inject. */
export const DEFAULT_REMINDERS_AGENDA_DAYS = 14;
export const DEFAULT_REMINDERS_AGENDA_TIMEOUT_MS = 8_000;
export const REMINDERS_LIST_TOOL = 'list_reminders';
export const REMINDERS_AGENDA_TAG = 'reminders-agenda';

export interface ReminderAgendaItem {
  name?: string;
  id?: string;
  uid?: string;
  completed?: boolean;
  dueDate?: string | null;
  priority?: number;
  list?: string;
}

export type RemindersAgendaFetch =
  | { available: true; reminders: ReminderAgendaItem[]; list: string }
  | { available: false; reason: 'missing-tool' | 'timeout' | 'error' };

export function historyHasRemindersAgenda(history: ChatMessage[]): boolean {
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          : '';
    if (text.includes(`<${REMINDERS_AGENDA_TAG}`)) return true;
  }
  return false;
}

function isMcpError(result: string): boolean {
  return /^(?:MCP tool error(?:\s|\()|MCP server not connected:|Unknown MCP tool:)/i.test(result.trim());
}

export function formatReminderLine(item: ReminderAgendaItem, listFallback?: string): string {
  const title = (item.name ?? '').trim() || '(untitled)';
  const list = (item.list ?? listFallback ?? '').trim();
  const id = (item.uid ?? item.id ?? '').trim();
  const due = (item.dueDate ?? '').trim();
  const parts = [title];
  if (due) parts.push(`due:${due}`);
  if (list) parts.push(list);
  if (id) parts.push(`id:${id}`);
  return parts.join(' | ');
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keep undated / overdue / near-term reminders; drop ones due past the agenda horizon.
 * Unparseable due strings stay (fail open — better to show than hide).
 */
export function isReminderInAgendaWindow(
  item: ReminderAgendaItem,
  now: Date = new Date(),
  days: number = DEFAULT_REMINDERS_AGENDA_DAYS,
): boolean {
  const due = (item.dueDate ?? '').trim();
  if (!due) return true;
  const { date } = compactEventTime(due);
  if (!YMD.test(date)) return true;
  const { to } = calendarAgendaWindow(now, days);
  return date <= to;
}

export function filterRemindersForAgenda(
  reminders: ReminderAgendaItem[],
  now: Date = new Date(),
  days: number = DEFAULT_REMINDERS_AGENDA_DAYS,
): ReminderAgendaItem[] {
  return reminders.filter((r) => isReminderInAgendaWindow(r, now, days));
}

/**
 * Incomplete default-list injection — undated + due within ~14 days; no char truncation.
 * Empty lists still produce a sentinel so the session does not re-fetch.
 */
export function buildRemindersAgendaBlock(reminders: ReminderAgendaItem[], list: string): string {
  const listName = list.trim();
  const listAttr = listName ? ` list="${listName}"` : '';
  const header = `<${REMINDERS_AGENDA_TAG}${listAttr}>`;
  const footer = `</${REMINDERS_AGENDA_TAG}>`;
  if (reminders.length === 0) {
    return `${header}\n(no reminders)\n${footer}`;
  }
  // List is already on the tag; keep lines to title / due / id (plan sketch).
  const lines = reminders.map((r) => formatReminderLine({ ...r, list: undefined }));
  return `${header}\n${lines.join('\n')}\n${footer}`;
}

/** `{list, total, truncated, reminders}` from the host, or a bare array from an older one. */
function asReminderItems(parsed: unknown): ReminderAgendaItem[] | null {
  if (Array.isArray(parsed)) return parsed as ReminderAgendaItem[];
  if (parsed && typeof parsed === 'object') {
    const { reminders } = parsed as { reminders?: unknown };
    if (Array.isArray(reminders)) return reminders as ReminderAgendaItem[];
  }
  return null;
}

function parseRemindersJson(raw: string): ReminderAgendaItem[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return asReminderItems(JSON.parse(trimmed)) ?? [];
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try {
        return asReminderItems(JSON.parse(trimmed.slice(start, end + 1))) ?? [];
      } catch {
        /* fall through */
      }
    }
    return [];
  }
}

/** Fetch incomplete reminders from the default list, dropping ones due past the agenda horizon. */
export async function fetchRemindersAgenda(
  bridge: RecallBridge,
  opts?: {
    timeoutMs?: number;
    defaultRemindersList?: string | null;
    now?: Date;
    days?: number;
  },
): Promise<RemindersAgendaFetch> {
  if (!bridge.has(REMINDERS_LIST_TOOL)) return { available: false, reason: 'missing-tool' };

  const list = opts?.defaultRemindersList?.trim() ?? '';
  // Fail closed: no default → empty sentinel (caller still injects so we do not re-fetch).
  if (!list) {
    return { available: true, reminders: [], list: '' };
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REMINDERS_AGENDA_TIMEOUT_MS;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      bridge.call(REMINDERS_LIST_TOOL, { include_completed: false }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null) return { available: false, reason: 'timeout' };
    if (isMcpError(result)) return { available: false, reason: 'error' };
    const reminders = filterRemindersForAgenda(
      parseRemindersJson(result).filter((r) => r.completed !== true),
      opts?.now ?? new Date(),
      opts?.days ?? DEFAULT_REMINDERS_AGENDA_DAYS,
    );
    return { available: true, reminders, list };
  } catch {
    return { available: false, reason: 'error' };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Same insert point as calendar — before the latest user turn. */
export const remindersAgendaInsertIndex = calendarAgendaInsertIndex;
