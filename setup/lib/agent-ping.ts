import { spawn } from 'node:child_process';
export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error';
export function classifyPingResult(code: number | null, output: string, errors = ''): PingResult {
  if (/authentication[_ ]error|invalid (api key|bearer token)|failed to authenticate/i.test(`${output}\n${errors}`))
    return 'auth_error';
  return code === 2 ? 'socket_error' : code === 0 && output.trim() ? 'ok' : 'no_reply';
}
export async function pingCliAgent(timeoutMs = 30_000): Promise<PingResult> {
  const child = spawn('pnpm', ['run', 'luna', 'ask', 'ping'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    const captured = { output: '', errors: '' };
    let finished = false;
    const complete = (result: PingResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      complete('no_reply');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (text: string) => (captured.output += text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => (captured.errors += text));
    child.once('error', () => complete('socket_error'));
    child.once('close', (code) => complete(classifyPingResult(code, captured.output, captured.errors)));
  });
}
