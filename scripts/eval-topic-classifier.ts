/**
 * scripts/eval-topic-classifier.ts — replay real conversation turns through the
 * topic decision and show what it would do now.
 *
 * Manual, deliberately outside every test glob: it spends memory-model tokens
 * and its answers depend on a live endpoint. `--dry` runs the free gate alone,
 * which costs nothing and is the right loop while iterating on the regexes.
 *
 * The corpus has no ground-truth labels, so the output is a *disagreement list*
 * for a human to read, not an accuracy number. What it is good for: seeing
 * which turns changed, spotting episodes that swallowed several subjects, and
 * checking that a prompt edit moved the cases you meant it to move.
 *
 * Usage:
 *   pnpm exec tsx scripts/eval-topic-classifier.ts --dry
 *   pnpm exec tsx scripts/eval-topic-classifier.ts [--limit 60] [--session <id>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { resolveMemoryModelConfig } from '../src/config/loader.js';
import { decideEpisode, freeGate, type MemoryChatFn } from '../container/agent-runner/src/providers/openai/episodes/decide.js';
import { isInjectedBlock, unwrapUserText } from '../container/agent-runner/src/providers/openai/episodes/format.js';
import type { Episode } from '../container/agent-runner/src/providers/openai/episodes/ledger.js';
import type { ChatMessage } from '../container/agent-runner/src/providers/openai/types.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SESSIONS_DIR = `${ROOT}/data/sessions`;
const HISTORY_DIR = `${ROOT}/agent/.openai-sessions`;

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const limit = Number(args[args.indexOf('--limit') + 1]) || (dry ? Infinity : 60);
const wantSession = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;

// --- corpus -----------------------------------------------------------------

/** The newest session DB that has both messages and an episode ledger. */
function findSessionDb(): string {
  const candidates: { db: string; mtime: number }[] = [];
  for (const group of fs.readdirSync(SESSIONS_DIR)) {
    const groupDir = path.join(SESSIONS_DIR, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const sess of fs.readdirSync(groupDir)) {
      if (wantSession && sess !== wantSession) continue;
      const db = path.join(groupDir, sess, 'session.db');
      if (fs.existsSync(db)) candidates.push({ db, mtime: fs.statSync(db).mtimeMs });
    }
  }
  const best = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (!best) throw new Error(`No session.db found under ${SESSIONS_DIR}`);
  return best.db;
}

interface Turn {
  text: string;
  at: Date;
  /** Minutes since the previous user message — the gap the gate actually saw. */
  idleMinutes: number;
}

function readTurns(dbPath: string): Turn[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare("SELECT timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') ORDER BY seq")
    .all() as { timestamp: string; content: string }[];
  db.close();

  const turns: Turn[] = [];
  let prev: number | null = null;
  for (const row of rows) {
    let text = '';
    try {
      text = String((JSON.parse(row.content) as { text?: string }).text ?? '').trim();
    } catch {
      continue;
    }
    // Slash commands never reach the topic decision.
    if (!text || text.startsWith('/')) continue;
    const at = new Date(row.timestamp);
    if (prev !== null) turns.push({ text, at, idleMinutes: (at.getTime() - prev) / 60_000 });
    prev = at.getTime();
  }
  return turns;
}

function readLedger(dbPath: string): Episode[] {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM session_state WHERE key = 'episodes'").get() as
    | { value: string }
    | undefined;
  db.close();
  if (!row) return [];
  return JSON.parse(row.value) as Episode[];
}

function loadHistory(historyId: string): ChatMessage[] {
  const file = path.join(HISTORY_DIR, `${historyId}.json`);
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { messages: ChatMessage[] }).messages ?? [];
}

// --- model ------------------------------------------------------------------

/**
 * The memory model, wired up host-side.
 *
 * Not `memoryChat`: that resolves its endpoint from the container's
 * /workspace/.luna-container.json, which does not exist here, and would quietly
 * fall through to the OPENAI_* env vars instead. `decideEpisode` takes an
 * injectable `chat` for exactly this reason.
 *
 * Plain fetch rather than the OpenAI SDK — that dependency lives in the
 * container workspace, not the host's, and this is one POST.
 */
function buildChat(): MemoryChatFn {
  // Directly, not via enrichForRuntime — that rewrites localhost URLs to be
  // reachable *from a container*, which is wrong on the host.
  const cfg = resolveMemoryModelConfig();
  if (!cfg.baseUrl || !cfg.chatModel) {
    throw new Error('models.memory is not configured — set it in config/local.jsonc, or pass --dry');
  }
  console.log(`Classifier: ${cfg.chatModel} at ${cfg.baseUrl}\n`);

  // Dropped after the endpoint 400s on them, the way memoryChat probes. The
  // body has to match memoryChat's or the eval measures the wrong thing —
  // reasoning_effort in particular is load-bearing: without it some endpoints
  // reject every temperature but their default.
  const dropped = new Set<string>();

  const call = async (body: Record<string, unknown>): Promise<string | null> => {
    const res = await fetch(`${cfg.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey ?? 'sk-no-key-required'}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content?.trim() ?? null;
    }

    const text = await res.text();
    const param = ['temperature', 'reasoning_effort', 'response_format', 'max_completion_tokens'].find(
      (p) => text.includes(`'${p}'`) && !dropped.has(p),
    );
    if (res.status === 400 && param) {
      dropped.add(param);
      console.error(`  ! endpoint rejected ${param} — dropping it and retrying`);
      const { [param]: _omit, ...rest } = body;
      return call(rest);
    }
    console.error(`  ! ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    return null;
  };

  return async (messages, opts) => {
    const body: Record<string, unknown> = {
      model: cfg.chatModel,
      messages,
      max_completion_tokens: opts?.maxTokens ?? 400,
      temperature: opts?.temperature ?? 0,
      reasoning_effort: 'none',
      ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
    };
    for (const p of dropped) delete body[p];
    try {
      return await call(body);
    } catch (err) {
      console.error(`  ! model call failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
}

// --- run --------------------------------------------------------------------

const dbPath = findSessionDb();
const turns = readTurns(dbPath);
const ledger = readLedger(dbPath);
console.log(`${path.relative(ROOT, dbPath)} — ${turns.length} user turns, ${ledger.length} episodes in the ledger\n`);

if (dry) {
  const tally: Record<string, number> = {};
  const continued: string[] = [];
  for (const turn of turns) {
    const lastActiveAt = new Date(turn.at.getTime() - turn.idleMinutes * 60_000).toISOString();
    const gate = freeGate(turn.text, { lastActiveAt, now: turn.at });
    tally[`${gate.kind}:${gate.reason}`] = (tally[`${gate.kind}:${gate.reason}`] ?? 0) + 1;
    if (gate.kind === 'continue') {
      continued.push(`  ${gate.reason.padEnd(20)} @${turn.idleMinutes.toFixed(1).padStart(7)}m  ${turn.text.slice(0, 70)}`);
    }
  }
  const asked = turns.length - continued.length;
  console.log(`Free gate: ${continued.length} settled without a model call, ${asked} handed to the classifier\n`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log('\nSettled as `continue` for free — every one of these must be a real follow-up:');
  continued.forEach((line) => console.log(line));
  process.exit(0);
}

/**
 * Walk the ledger and re-decide each turn *where it actually happened*.
 *
 * Position matters more than anything else here. Judging every turn against the
 * newest episode makes almost everything look unrelated and the switch rate
 * meaningless, so each turn is replayed against the episode that held it, with
 * that episode's history truncated to what had been said before it and the
 * ledger truncated to the topics that existed at the time.
 *
 * The ground truth this measures against is weak by construction: the corpus
 * was produced by the *old* gate, so a turn sitting inside an episode is not
 * evidence that it belonged there — that is the bug being fixed. Read the
 * switches, not the percentage.
 */
const MESSAGE_TIME_RE = /<message\b[^>]*\btime="([^"]*)"/;

interface Replay {
  episode: Episode;
  /** Index in the episode's history — everything before it is prior context. */
  index: number;
  text: string;
  at: Date | null;
}

function episodeTurns(episode: Episode): Replay[] {
  const out: Replay[] = [];
  loadHistory(episode.historyId).forEach((msg, index) => {
    if (msg.role !== 'user' || typeof msg.content !== 'string') return;
    if (isInjectedBlock(msg.content)) return;
    const text = unwrapUserText(msg.content).trim();
    if (!text) return;
    const stamp = MESSAGE_TIME_RE.exec(msg.content)?.[1];
    const at = stamp ? new Date(stamp) : null;
    out.push({ episode, index, text, at: at && !Number.isNaN(at.getTime()) ? at : null });
  });
  return out;
}

const chat = buildChat();
const recent = ledger.flatMap(episodeTurns).slice(-limit);
const counts: Record<string, number> = { continue: 0, new: 0, resume: 0 };
const switches: string[] = [];

let previousAt: Date | null = null;
for (const turn of recent) {
  const at = turn.at ?? previousAt ?? new Date(turn.episode.startedAt);
  // The gap the gate would really have seen: since the previous user turn.
  const lastActive = previousAt ?? new Date(turn.episode.startedAt);
  previousAt = at;
  const idleMinutes = Math.max(0, (at.getTime() - lastActive.getTime()) / 60_000);

  // The ledger as it stood: this episode current, everything before it earlier.
  // Its summary is cleared — the stored one was written after the fact.
  const upTo = ledger.slice(0, ledger.findIndex((e) => e.id === turn.episode.id) + 1);
  const episodes = upTo.map((e) =>
    e.id === turn.episode.id ? { ...e, lastActiveAt: lastActive.toISOString(), summary: null } : e,
  );

  const decision = await decideEpisode({
    userText: turn.text,
    episodes,
    history: loadHistory(turn.episode.historyId).slice(0, turn.index),
    now: at,
    chat,
  });

  counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  const line =
    `${decision.action.padEnd(8)} ${decision.reason.padEnd(24)} @${idleMinutes.toFixed(1).padStart(7)}m  ` +
    `[${turn.episode.emoji} ${turn.episode.title.slice(0, 24)}] ${turn.text.slice(0, 54)}` +
    `${decision.title ? `  → ${decision.emoji ?? ''} ${decision.title}` : ''}`;
  console.log(line);
  if (decision.action !== 'continue') switches.push(line);
}

const switched = (counts.new ?? 0) + (counts.resume ?? 0);
console.log(
  `\n${recent.length} turns — continue ${counts.continue}, new ${counts.new}, resume ${counts.resume}` +
    ` (${((switched * 100) / recent.length).toFixed(0)}% switch rate)`,
);
console.log('\nReview by hand. A switch away from the topic in brackets is the change worth judging:');
switches.forEach((line) => console.log(`  ${line}`));
