/**
 * `luna` binary entry point.
 *
 * Parses argv, builds a request frame, sends it via the picked transport,
 * formats the response, exits non-zero on error.
 *
 * Usage:
 *   luna <resource> <verb> [target] [--key value ...] [--json]
 *
 * Examples:
 *   luna status
 *   luna config
 *   luna restart
 *   luna status
 *   luna help
 *   luna help --all
 */
import { randomUUID } from 'crypto';

import { CENTRAL_DB_PATH } from '../config.js';
import { closeDb, getDb, initDb } from '../db/connection.js';
import { initializeCentralSchema } from '../db/initialize.js';
import './commands/index.js';
import { dispatch } from './dispatch.js';
import { formatResponse } from './format.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import { lookup } from './registry.js';
import { SocketTransport } from './socket-client.js';
import type { Transport } from './transport.js';
import { formatTransportError } from './transport-errors.js';

/** Commands that need the running host process (live container map, etc.). */
const SOCKET_ONLY_COMMANDS = new Set(['status', 'health']);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    printUsage();
    process.exit(0);
  }

  const chatParsed = (await import('./chat-client.js')).parseChatArgv(argv);
  if (chatParsed) {
    const { runChatClient } = await import('./chat-client.js');
    const code = await runChatClient({
      mode: chatParsed.mode,
      message: chatParsed.message,
      timeoutMs: chatParsed.timeoutMs,
      json: chatParsed.json,
    });
    process.exit(code);
  }

  if (argv.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Interactive setup — inherit stdio; must not go through dispatch/formatResponse.
  if (argv[0] === 'setup') {
    const { runSetupPassthrough } = await import('./setup-runner.js');
    process.exit(runSetupPassthrough(argv.slice(1)));
  }

  const { command, args, json } = parseArgv(argv);
  const req: RequestFrame = { id: randomUUID(), command, args };

  let res: ResponseFrame;
  try {
    if (lookup(command) && !SOCKET_ONLY_COMMANDS.has(command)) {
      res = await dispatchInProcess(req);
    } else {
      try {
        res = await pickTransport().sendFrame(req);
      } catch (e) {
        // Socket-only commands need the live host for containers/liveness.
        // When the host is down, fall back to in-process so `luna health`
        // still returns config/DB/probe data instead of a hard ENOENT.
        const msg = e instanceof Error ? e.message : String(e);
        if (
          SOCKET_ONLY_COMMANDS.has(command) &&
          lookup(command) &&
          (msg.includes('ENOENT') || msg.includes('ECONNREFUSED'))
        ) {
          res = await dispatchInProcess(req);
          if (res.ok && command === 'health' && res.data && typeof res.data === 'object') {
            (res.data as Record<string, unknown>).host_socket = 'unreachable';
            (res.data as Record<string, unknown>).note =
              'Host socket unreachable — live runtime/MCP supervisor state may be incomplete. Start the host for a full report.';
          }
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    process.stderr.write(formatTransportError(e));
    process.exit(2);
  }

  process.stdout.write(formatResponse(res, json ? 'json' : 'human'));
  process.exit(res.ok ? 0 : 1);
}

function pickTransport(): Transport {
  return new SocketTransport();
}

/**
 * Run CLI handlers in this process so new commands work without restarting
 * the launchd host (the socket server only loads commands at host startup).
 */
async function dispatchInProcess(req: RequestFrame): Promise<ResponseFrame> {
  const skipDbInit = req.command === 'db-reset';
  try {
    if (!skipDbInit) {
      initDb(CENTRAL_DB_PATH);
      initializeCentralSchema(getDb());
    }
    return await dispatch(req, { caller: 'host' });
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      error: { code: 'handler-error', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    closeDb();
  }
}

function parseArgv(argv: string[]): {
  command: string;
  args: Record<string, unknown>;
  json: boolean;
} {
  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
      continue;
    }
    positional.push(a);
  }

  if (positional.length === 0) {
    process.stderr.write('luna: missing command\n');
    printUsage();
    process.exit(2);
  }

  if (json) {
    args.json = true;
  }

  // Join all positionals with dashes to form the command name.
  // If the full name isn't a command, the dispatcher will try trimming
  // the last segment and using it as the target ID (e.g. `groups get abc`
  // → command "groups-get", id "abc").
  const command = positional.join('-');

  return { command, args, json };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: luna [<message>]              Interactive chat (TTY)',
      '       luna ask <message...>         One-shot prompt (ephemeral session)',
      '       luna <resource> <verb> [...]    Admin / CRUD commands',
      '       luna config <topic>           Unified config (agent, memory, apple, …)',
      '',
      '  luna setup              First-time install (interactive wizard)',
      '  luna build              Rebuild host + container image for development',
      '  luna service <verb>     Start/stop/restart the host service',
      '',
      'Run `luna help` to list available resources and commands.',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`luna: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
