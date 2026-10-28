#!/usr/bin/env bun
/**
 * luna — Luna CLI client (container edition).
 *
 * Same interface as the host-side `bin/luna`. Inside a container it talks to
 * the host Session API over HTTP (LUNA_SESSION_API_URL + LUNA_SESSION_TOKEN),
 * exactly like the agent-runner — no SQLite, no mount access.
 *
 * Writes a cli_request as an outbound system message, polls the inbound side
 * for the matching cli_response. Self-contained — no imports from agent-runner.
 */

// ---------------------------------------------------------------------------
// Frame types (mirrors src/cli/frame.ts on the host)
// ---------------------------------------------------------------------------

type RequestFrame = {
  id: string;
  command: string;
  args: Record<string, unknown>;
};

type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Session API transport
// ---------------------------------------------------------------------------

const RPC_URL = (process.env.LUNA_SESSION_API_URL ?? '').replace(/\/$/, '') + '/rpc';
const RPC_TOKEN = process.env.LUNA_SESSION_TOKEN ?? '';

function generateId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${RPC_TOKEN}` },
    body: JSON.stringify({ method, params }),
  });
  if (!res.ok) throw new Error(`session-api ${method} → HTTP ${res.status}`);
  const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!json.ok) throw new Error(json.error || `session-api ${method} failed`);
  return json.result as T;
}

/** Write a cli_request as an outbound system message. */
async function writeRequest(req: RequestFrame): Promise<void> {
  await rpc('writeMessageOut', {
    msg: {
      id: req.id,
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: req.id,
        command: req.command,
        args: req.args,
      }),
    },
  });
}

/** Poll the inbound side for a cli_response matching our requestId. */
async function pollResponse(requestId: string, timeoutMs: number): Promise<ResponseFrame | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const row = await rpc<{ id: string; content: string } | null>('findCliResponse', { requestId });
    if (row) {
      // Mark completed so the agent-runner won't re-process the response row.
      await rpc('markCompleted', { ids: [row.id] });
      const parsed = JSON.parse(row.content);
      return parsed.frame as ResponseFrame;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Arg parsing (mirrors host-side client.ts)
// ---------------------------------------------------------------------------

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

  // Join all positionals with dashes. The dispatcher trims the last
  // segment as a target ID if the full name isn't a registered command.
  const command = positional.join('-');

  return { command, args, json };
}

function printUsage(): void {
  process.stdout.write(
    ['Usage: luna <command> [--key value ...] [--json]', '', 'Run `luna help` to list available commands.', ''].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Formatting (mirrors src/cli/format.ts on the host)
// ---------------------------------------------------------------------------

function formatHuman(resp: ResponseFrame): string {
  if (!resp.ok) {
    return `error (${resp.error.code}): ${resp.error.message}\n`;
  }

  const data = resp.data;
  if (!Array.isArray(data) || data.length === 0) {
    return JSON.stringify(data, null, 2) + '\n';
  }

  const isFlat = data.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      !Array.isArray(r) &&
      Object.values(r as Record<string, unknown>).every((v) => typeof v !== 'object' || v === null),
  );

  if (!isFlat) return JSON.stringify(data, null, 2) + '\n';

  const keys = Object.keys(data[0] as Record<string, unknown>);
  const widths = keys.map((k) =>
    Math.max(k.length, ...data.map((r) => String((r as Record<string, unknown>)[k] ?? '').length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const rows = data.map((r) =>
    keys
      .map((k, i) => String((r as Record<string, unknown>)[k] ?? '').padEnd(widths[i]))
      .join('  '),
  );

  return [header, sep, ...rows, ''].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printUsage();
  process.exit(0);
}

const { command, args, json } = parseArgv(argv);
const requestId = generateId();
const req: RequestFrame = { id: requestId, command, args };

if (!process.env.LUNA_SESSION_API_URL || !RPC_TOKEN) {
  process.stderr.write('luna: session API not configured (LUNA_SESSION_API_URL / LUNA_SESSION_TOKEN missing)\n');
  process.exit(2);
}

await writeRequest(req);

const resp = await pollResponse(requestId, 30_000);

if (!resp) {
  process.stderr.write('luna: command timed out after 30s\n');
  process.exit(2);
}

if (json) {
  process.stdout.write(JSON.stringify(resp, null, 2) + '\n');
} else {
  const output = formatHuman(resp);
  if (!resp.ok) {
    process.stderr.write(output);
    process.exit(1);
  }
  process.stdout.write(output);
}
