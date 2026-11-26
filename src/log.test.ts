import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepWritingThroughFailures } from './log.js';

const writeSync = fs.writeSync;
let dir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A file-backed stream whose own write fails the way Node's synchronous file stream does. */
function logFile() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-log-'));
  const file = path.join(dir, 'luna.error.log');
  const stream = Object.assign(
    new Writable({ write: (_chunk, _encoding, callback) => callback(new Error('the default write ran')) }),
    { fd: fs.openSync(file, 'a') },
  );
  const errors: unknown[] = [];
  stream.on('error', (error) => errors.push(error));
  keepWritingThroughFailures(stream);
  return { stream, file, errors };
}

function diskFull(): never {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

async function finish(stream: Writable & { fd: number }) {
  stream.end();
  await once(stream, 'finish');
  fs.closeSync(stream.fd);
}

describe('log output on a full disk', () => {
  it('keeps writing after a failed write and says how much was lost', async () => {
    const { stream, file, errors } = logFile();
    stream.write('Ada Marlow joined\n');
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(diskFull);
    stream.write('lost line\n');
    stream.write('Bo Winters joined\n');
    await finish(stream);

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toEqual([
      'Ada Marlow joined',
      expect.stringMatching(/^\S+Z WARN 10 bytes of log output were lost$/),
      'Bo Winters joined',
    ]);
    expect(errors).toEqual([]);
    expect(stream.errored).toBeNull();
  });

  it('keeps the loss count until a notice can be written', async () => {
    const { stream, file } = logFile();
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(diskFull).mockImplementationOnce(diskFull);
    stream.write('first lost\n');
    stream.write('second lost\n');
    stream.write('Vulpine Mutual renewal noted\n');
    await finish(stream);

    expect(fs.readFileSync(file, 'utf8')).toMatch(
      /^\S+Z WARN 23 bytes of log output were lost\nVulpine Mutual renewal noted\n$/,
    );
  });

  it('completes a line the disk accepted only in part', async () => {
    const { stream, file } = logFile();
    vi.spyOn(fs, 'writeSync').mockImplementationOnce((fd, data, offset) =>
      writeSync(fd as number, data as Buffer, offset as number, 4),
    );
    stream.write('Blackwater Bay ferry booked\n');
    await finish(stream);

    expect(fs.readFileSync(file, 'utf8')).toBe('Blackwater Bay ferry booked\n');
  });

  it('leaves terminals and streams without a file alone', () => {
    const write = (_chunk: unknown, _encoding: unknown, callback: () => void) => callback();
    const piped = new Writable({ write });
    const terminal = Object.assign(new Writable({ write }), { fd: 1, isTTY: true });
    const pipedWrite = piped._write;
    const terminalWrite = terminal._write;
    keepWritingThroughFailures(piped);
    keepWritingThroughFailures(terminal);
    expect(piped._write).toBe(pipedWrite);
    expect(terminal._write).toBe(terminalWrite);
  });
});
