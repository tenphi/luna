import { inspect } from 'node:util';

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
