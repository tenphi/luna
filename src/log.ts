import fs from 'node:fs';
import type { Writable } from 'node:stream';
import { inspect } from 'node:util';

function writeAll(fd: number, data: Buffer): void {
  for (let offset = 0; offset < data.length;) offset += fs.writeSync(fd, data, offset);
}

/**
 * launchd points stdout and stderr at log files, which Node writes synchronously. A failed write,
 * such as on a full disk, errors the stream: with no listener that is an uncaught exception, and
 * either way every later line is dropped, even once the disk has room again. Keep file output
 * best-effort instead: drop what cannot be written, say how much was lost when writing works
 * again, and never fail the stream. Terminals and pipes keep their normal behavior.
 */
export function keepWritingThroughFailures(stream: Writable & { fd?: unknown; isTTY?: boolean }): void {
  const fd = stream.fd;
  if (typeof fd !== 'number' || stream.isTTY) return;
  try {
    if (!fs.fstatSync(fd).isFile()) return;
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unknown descriptor keeps Node's own stream behavior.
  } catch {
    return;
  }
  let dropped = 0;
  stream._write = (chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
    try {
      if (dropped) {
        writeAll(fd, Buffer.from(`${new Date().toISOString()} WARN ${dropped} bytes of log output were lost\n`));
        dropped = 0;
      }
      writeAll(fd, data);
      // eslint-disable-next-line no-catch-all/no-catch-all -- A log write that fails has nowhere else to report to.
    } catch {
      dropped += data.length;
    }
    callback();
  };
}
keepWritingThroughFailures(process.stdout);
keepWritingThroughFailures(process.stderr);

type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const priorities: Severity[] = ['debug', 'info', 'warn', 'error', 'fatal'];
const configured = priorities.indexOf(process.env.LOG_LEVEL as Severity);
const minimum = configured < 0 ? 1 : configured;
const ansi = ['34', '32', '33', '31', '41;37'];

function write(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  const rank = priorities.indexOf(severity);
  if (rank < minimum) return;
  const stream = rank >= 2 ? process.stderr : process.stdout;
  const colored = stream.isTTY;
  const label = colored ? `\x1b[${ansi[rank]}m${severity.toUpperCase()}\x1b[0m` : severity.toUpperCase();
  const details = Object.entries(fields).map(
    ([key, value]) => `${key}=${inspect(value, { colors: colored, breakLength: Infinity, depth: 4 })}`,
  );
  stream.write(`${new Date().toISOString()} ${label} ${message}${details.length ? ' ' + details.join(' ') : ''}\n`);
}

export const log: Record<Severity, (message: string, fields?: Record<string, unknown>) => void> = Object.fromEntries(
  priorities.map((severity) => [
    severity,
    (message: string, fields?: Record<string, unknown>) => write(severity, message, fields),
  ]),
) as typeof log;

if (!process.listenerCount('uncaughtException')) {
  process.on('uncaughtException', (error) => {
    write('fatal', 'Host terminated by an uncaught exception', { error });
    process.exit(1);
  });
}
if (!process.listenerCount('unhandledRejection')) {
  process.on('unhandledRejection', (error) => write('error', 'Unhandled asynchronous failure', { error }));
}
