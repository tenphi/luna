/**
 * Conversation persistence for the OpenAI provider.
 *
 * The model API keeps no server-side session to resume (Chat Completions, and
 * Responses with `store: false`). To honor the poll-loop's continuation contract we persist the full
 * running message array (system message excluded; it's rebuilt each turn) to
 * a JSON file keyed by an opaque UUID. The UUID is the "continuation" the
 * poll-loop stores per provider in the session's `session_state` table.
 */
import fs from 'fs';
import path from 'path';

import type { ChatMessage } from './types.js';

const DEFAULT_SESSIONS_DIR = '/workspace/agent/.openai-sessions';

let sessionsDirOverride: string | null = null;

/** Test hook: redirect session files to a temp directory. */
export function setSessionsDirForTests(dir: string | null): void {
  sessionsDirOverride = dir;
}

function sessionsDir(): string {
  return sessionsDirOverride ?? DEFAULT_SESSIONS_DIR;
}

function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export interface SessionPayload {
  messages: ChatMessage[];
  updated_at: string;
  last_compaction_at?: string;
}

export function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function loadSession(id: string): SessionPayload | null {
  try {
    const raw = fs.readFileSync(sessionFile(id), 'utf-8');
    const parsed = JSON.parse(raw) as SessionPayload;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadHistory(id: string): ChatMessage[] | null {
  return loadSession(id)?.messages ?? null;
}

export function saveHistory(
  id: string,
  messages: ChatMessage[],
  meta?: { lastCompactionAt?: string },
): void {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const existing = loadSession(id);
    const payload: SessionPayload = {
      messages,
      updated_at: new Date().toISOString(),
      ...(meta?.lastCompactionAt
        ? { last_compaction_at: meta.lastCompactionAt }
        : existing?.last_compaction_at
          ? { last_compaction_at: existing.last_compaction_at }
          : {}),
    };
    fs.writeFileSync(sessionFile(id), JSON.stringify(payload));
  } catch (err) {
    console.error(`[openai-provider] Failed to save session ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function sessionExists(id: string): boolean {
  return fs.existsSync(sessionFile(id));
}

export function sessionSize(id: string): number | null {
  try {
    return fs.statSync(sessionFile(id)).size;
  } catch {
    return null;
  }
}

export function rotateSession(id: string): void {
  try {
    fs.renameSync(sessionFile(id), `${sessionFile(id)}.rotated-${Date.now()}`);
  } catch {
    /* best-effort */
  }
}

/**
 * Drop a history file for good. Used when an episode falls off the ledger:
 * nothing can reach the file once its entry is gone, so keeping it would only
 * grow the session folder.
 */
export function deleteSession(id: string): void {
  try {
    fs.unlinkSync(sessionFile(id));
  } catch {
    /* already gone */
  }
}

/** Rewrite session file with compacted messages (same id). Returns new byte size. */
export function rewriteSession(id: string, messages: ChatMessage[]): number | null {
  saveHistory(id, messages, { lastCompactionAt: new Date().toISOString() });
  return sessionSize(id);
}
