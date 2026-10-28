/**
 * Luna terminal chat client — talks to the host CLI channel via data/cli.sock.
 *
 * Modes:
 *   interactive — bare `luna` REPL; persistent socket, shared session
 *   ask         — `luna ask "…"` one-shot; ephemeral session per message
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import kleur from 'kleur';

import { renderCommandNames } from '../commands.js';
import { DATA_DIR } from '../config.js';

export type ChatMode = 'interactive' | 'ask';

export interface ChatClientOptions {
  mode: ChatMode;
  message?: string;
  timeoutMs?: number;
  json?: boolean;
}

const SILENCE_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

export function cliSocketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function isChatTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function shouldStartInteractiveChat(argv: string[]): boolean {
  return argv.length === 0 && isChatTty();
}

type ServerMessage = { text?: string; type?: string; line?: string; lines?: string[] } | Record<string, unknown>;

// ANSI helpers for in-place status block redraw on stderr (TTY only).
// We track how many lines the last drawn status block occupies so we can
// erase it before drawing the next frame or before the answer lands on stdout.
const ANSI_UP = (n: number) => `\x1B[${n}A`;
const ANSI_CLEAR_BELOW = '\x1B[0J';

function isStderrTty(): boolean {
  return Boolean((process.stderr as NodeJS.WriteStream).isTTY);
}

/** Mutable per-process status block tracker (one chat client per process). */
let drawnStatusLines = 0;

function clearStatusBlock(): void {
  if (!isStderrTty() || drawnStatusLines === 0) return;
  process.stderr.write(ANSI_UP(drawnStatusLines) + ANSI_CLEAR_BELOW);
  drawnStatusLines = 0;
}

function drawStatusBlock(lines: string[]): void {
  if (!isStderrTty()) return;
  clearStatusBlock();
  if (lines.length === 0) return;
  process.stderr.write(kleur.dim(lines.join('\n')) + '\n');
  drawnStatusLines = lines.length;
}

class ChatSocket {
  private socket: net.Socket | null = null;
  private buffer = '';
  private silenceTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private firstReplySeen = false;
  private turnResolve: ((code: number) => void) | null = null;
  private readonly timeoutMs: number;
  private readonly json: boolean;

  constructor(timeoutMs: number, json: boolean) {
    this.timeoutMs = timeoutMs;
    this.json = json;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(cliSocketPath());
      this.socket = sock;

      sock.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
          reject(
            new Error(
              `Luna daemon not reachable at ${cliSocketPath()}.\n` +
                'Start the service before chatting (e.g. `luna service start`).',
            ),
          );
        } else {
          reject(err);
        }
      });

      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        this.clearTimers();
        if (this.turnResolve) {
          const resolve = this.turnResolve;
          this.turnResolve = null;
          resolve(this.firstReplySeen ? 0 : 3);
        }
      });

      sock.once('connect', () => resolve());
    });
  }

  send(text: string, ephemeral: boolean): void {
    if (!this.socket) throw new Error('not connected');
    const payload: Record<string, unknown> = { text };
    if (ephemeral) payload.ephemeral = true;
    this.socket.write(JSON.stringify(payload) + '\n');
    this.firstReplySeen = false;
    this.armHardTimeout();
  }

  waitForTurn(): Promise<number> {
    return new Promise((resolve) => {
      this.turnResolve = resolve;
    });
  }

  end(): void {
    this.clearTimers();
    try {
      this.socket?.end();
    } catch {
      // swallow
    }
    this.socket = null;
  }

  private armHardTimeout(): void {
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.hardTimer = setTimeout(() => {
      if (!this.firstReplySeen) {
        process.stderr.write(`timeout: no reply in ${this.timeoutMs}ms\n`);
        this.finishTurn(3);
      }
    }, this.timeoutMs);
  }

  private scheduleSilenceExit(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.finishTurn(0), SILENCE_MS);
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.silenceTimer = null;
    this.hardTimer = null;
  }

  private finishTurn(code: number): void {
    this.clearTimers();
    if (this.turnResolve) {
      const resolve = this.turnResolve;
      this.turnResolve = null;
      resolve(code);
    }
  }

  private onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(line) as ServerMessage;
    } catch {
      return;
    }

    if (msg.type === 'done') {
      // Guard against premature done notifications (e.g. tool progress before
      // the final assistant text). If no user-visible reply has arrived yet,
      // keep waiting for text or the hard timeout.
      if (!this.firstReplySeen) return;
      clearStatusBlock();
      this.finishTurn(0);
      return;
    }

    // Live thinking/status block — redrawn in place on stderr (TTY only).
    // For non-TTY (luna ask, piped, --json) these frames are silently ignored.
    if (msg.type === 'status' && Array.isArray(msg.lines)) {
      drawStatusBlock(msg.lines as string[]);
      return;
    }

    if (msg.type === 'tool' && typeof msg.line === 'string') {
      // Legacy cli-tool dim lines (kept for backward compatibility with
      // older container images that still emit them).
      if (!isStderrTty()) {
        process.stderr.write(kleur.dim(msg.line) + '\n');
      }
      return;
    }

    if (typeof msg.text === 'string') {
      // Clear the status block before printing the final answer so it
      // doesn't visually overlap with the response text.
      clearStatusBlock();
      if (this.json) {
        process.stdout.write(JSON.stringify({ text: msg.text }) + '\n');
      } else {
        process.stdout.write(msg.text + '\n');
      }
      this.firstReplySeen = true;
      if (this.hardTimer) {
        clearTimeout(this.hardTimer);
        this.hardTimer = null;
      }
      this.scheduleSilenceExit();
    }
  }
}

export async function runChatClient(opts: ChatClientOptions): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.mode === 'ask') {
    const message = opts.message?.trim();
    if (!message) {
      process.stderr.write('usage: luna ask <message...>\n');
      return 1;
    }
    return runAsk(message, timeoutMs, opts.json ?? false);
  }

  return runInteractive(timeoutMs, opts.json ?? false);
}

async function runAsk(message: string, timeoutMs: number, json: boolean): Promise<number> {
  const chat = new ChatSocket(timeoutMs, json);
  try {
    await chat.connect();
    chat.send(message, true);
    const code = await chat.waitForTurn();
    chat.end();
    return code;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

async function runInteractive(timeoutMs: number, json: boolean): Promise<number> {
  const chat = new ChatSocket(timeoutMs, json);
  try {
    await chat.connect();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Anyone who can reach the CLI socket already has host access, so the banner
  // shows the owner set rather than probing for a role.
  process.stdout.write('Luna — type a message (/exit or Ctrl-D to quit)\n');
  process.stdout.write(`Commands: ${renderCommandNames(true)}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question('> ', (answer) => resolve(answer));
    });

  let code = 0;
  try {
    while (true) {
      const line = await prompt();
      if (line === null) break;
      const text = line.trim();
      if (!text) break;
      if (text === '/exit') break;

      chat.send(text, false);
      code = await chat.waitForTurn();
      if (code !== 0) break;
    }
  } finally {
    rl.close();
    chat.end();
  }

  return code;
}

export function parseChatArgv(argv: string[]): {
  mode: ChatMode;
  message?: string;
  timeoutMs?: number;
  json?: boolean;
  consumed: number;
} | null {
  if (argv.length === 0) {
    if (shouldStartInteractiveChat([])) {
      return { mode: 'interactive', consumed: 0 };
    }
    return null;
  }

  const head = argv[0];
  if (head === 'ask' || head === 'chat') {
    let timeoutMs: number | undefined;
    let json = false;
    const rest: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') {
        json = true;
        continue;
      }
      if (a === '--timeout') {
        const val = argv[i + 1];
        if (val !== undefined && !val.startsWith('--')) {
          timeoutMs = Number(val);
          i++;
          continue;
        }
      }
      rest.push(a);
    }

    if (rest.length > 0) {
      return {
        mode: 'ask',
        message: rest.join(' '),
        timeoutMs,
        json,
        consumed: argv.length,
      };
    }

    if (head === 'chat' && isChatTty()) {
      return { mode: 'interactive', timeoutMs, json, consumed: argv.length };
    }

    if (head === 'ask') {
      process.stderr.write('usage: luna ask <message...>\n');
      process.exit(1);
    }
  }

  return null;
}
