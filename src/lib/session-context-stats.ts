/**
 * Inspect OpenAI provider session history files on the host (agent/.openai-sessions).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { SESSIONS_DIR } from '../config.js';
import { getAgentDir } from '../install-paths.js';
import { getTheAgent } from '../bootstrap.js';

const CHARS_PER_TOKEN = 4;

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

interface SessionPayload {
  messages: ChatMessage[];
  updated_at?: string;
  last_compaction_at?: string;
}

export interface SessionContextStats {
  sessionId: string;
  fileBytes: number;
  updatedAt?: string;
  lastCompactionAt?: string;
  messageCount: number;
  approxTokens: number;
  byRole: Record<string, number>;
  toolResultChars: number;
  largestToolResultChars: number;
  hasSummaryMessage: boolean;
  continuationSource?: 'session.db' | 'explicit';
}

function measureMessages(messages: ChatMessage[]): {
  approxTokens: number;
  byRole: Record<string, number>;
  toolResultChars: number;
  largestToolResultChars: number;
  hasSummaryMessage: boolean;
} {
  const byRole: Record<string, number> = {};
  let chars = 0;
  let toolResultChars = 0;
  let largestToolResultChars = 0;
  let hasSummaryMessage = false;

  for (const msg of messages) {
    byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
    const content = msg.content ?? '';
    if (msg.role === 'tool') {
      toolResultChars += content.length;
      if (content.length > largestToolResultChars) largestToolResultChars = content.length;
    }
    chars += content.length;
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<conversation_summary>')) {
      hasSummaryMessage = true;
    }
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        chars += (tc.function.name?.length ?? 0) + (tc.function.arguments?.length ?? 0);
      }
    }
  }

  return {
    approxTokens: Math.ceil(chars / CHARS_PER_TOKEN),
    byRole,
    toolResultChars,
    largestToolResultChars,
    hasSummaryMessage,
  };
}

function openaiSessionsDir(): string {
  return path.join(getAgentDir(), '.openai-sessions');
}

function readSessionFile(sessionsDir: string, sessionId: string): SessionPayload | null {
  const file = path.join(sessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionPayload;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function findNewestSessionDb(agentGroupId: string): string | null {
  const base = path.join(SESSIONS_DIR, agentGroupId);
  if (!fs.existsSync(base)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const sess of fs.readdirSync(base, { withFileTypes: true })) {
    if (!sess.isDirectory()) continue;
    const sessionDb = path.join(base, sess.name, 'session.db');
    if (!fs.existsSync(sessionDb)) continue;
    const mtime = fs.statSync(sessionDb).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path: sessionDb, mtime };
  }
  return newest?.path ?? null;
}

function continuationFromSessionDb(sessionDbPath: string, provider = 'openai'): string | undefined {
  const db = new Database(sessionDbPath, { readonly: true });
  try {
    const key = `continuation:${provider.toLowerCase()}`;
    const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

export function inspectSessionContext(opts: {
  continuation?: string;
  useSession?: boolean;
  provider?: string;
  agentGroupId?: string;
}): SessionContextStats {
  const group = opts.agentGroupId ? { id: opts.agentGroupId } : getTheAgent();

  const sessionsDir = openaiSessionsDir();
  let sessionId = opts.continuation;
  let continuationSource: SessionContextStats['continuationSource'] = opts.continuation ? 'explicit' : undefined;

  if (!sessionId && opts.useSession) {
    const sessionDb = findNewestSessionDb(group.id);
    if (!sessionDb) throw new Error('No session.db found for this agent');
    sessionId = continuationFromSessionDb(sessionDb, opts.provider ?? 'openai');
    continuationSource = 'session.db';
    if (!sessionId) throw new Error('No continuation stored in session.db for this provider');
  }

  if (!sessionId) {
    throw new Error('Provide --continuation <id> or --session to resolve from session.db');
  }

  const payload = readSessionFile(sessionsDir, sessionId);
  if (!payload) {
    throw new Error(`Session file not found: ${path.join(sessionsDir, `${sessionId}.json`)}`);
  }

  const file = path.join(sessionsDir, `${sessionId}.json`);
  const measured = measureMessages(payload.messages);

  return {
    sessionId,
    fileBytes: fs.statSync(file).size,
    updatedAt: payload.updated_at,
    lastCompactionAt: payload.last_compaction_at,
    messageCount: payload.messages.length,
    ...measured,
    continuationSource,
  };
}

export function formatSessionContextHuman(stats: SessionContextStats, tokens: boolean): string {
  const lines = [
    `session: ${stats.sessionId}`,
    `source: ${stats.continuationSource ?? 'explicit'}`,
    `file_bytes: ${stats.fileBytes}`,
    `messages: ${stats.messageCount}`,
    `approx_chars_tokens: ${stats.approxTokens * CHARS_PER_TOKEN} / ${stats.approxTokens}`,
    `roles: ${JSON.stringify(stats.byRole)}`,
    `tool_result_chars: ${stats.toolResultChars}`,
    `largest_tool_result_chars: ${stats.largestToolResultChars}`,
    `has_summary_message: ${stats.hasSummaryMessage}`,
  ];
  if (stats.updatedAt) lines.push(`updated_at: ${stats.updatedAt}`);
  if (stats.lastCompactionAt) lines.push(`last_compaction_at: ${stats.lastCompactionAt}`);
  if (tokens) {
    lines.push(`(token estimate uses chars/${CHARS_PER_TOKEN})`);
  }
  return lines.join('\n');
}
