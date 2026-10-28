import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  extractorFor,
  extractText,
  looksLikeRealText,
  pdfPageCount,
  renderPdfPages,
  runCommand,
  type RunFn,
  type RunResult,
} from './doc-extract.js';

let dir: string;

function ok(stdout: string): RunResult {
  return { status: 0, stdout, stderr: '', timedOut: false };
}

function fail(stderr = 'boom', timedOut = false): RunResult {
  return { status: 1, stdout: '', stderr, timedOut };
}

/** Records what was spawned so the flags can be asserted. */
function recorder(result: RunResult | ((cmd: string) => RunResult)): { run: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return typeof result === 'function' ? result(cmd) : result;
  };
  return { run, calls };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-extract-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractorFor', () => {
  it('routes by extension', () => {
    expect(extractorFor('invoice.pdf')).toBe('pdf');
    expect(extractorFor('contract.docx')).toBe('pandoc');
    expect(extractorFor('scan.png')).toBe('ocr');
    expect(extractorFor('notes.md')).toBe('text');
  });

  it('trusts an explicit PDF MIME over a useless filename', () => {
    // Telegram documents carry a good MIME and sometimes a numeric name.
    expect(extractorFor('123456789', 'application/pdf')).toBe('pdf');
    expect(extractorFor('123456789', 'application/pdf; charset=binary')).toBe('pdf');
  });

  it('falls back to the MIME family when the extension says nothing', () => {
    expect(extractorFor('blob', 'image/jpeg')).toBe('ocr');
    expect(extractorFor('blob', 'text/csv')).toBe('text');
  });

  it('returns null for what nothing in the image can read', () => {
    expect(extractorFor('note.ogg', 'audio/ogg')).toBeNull();
    expect(extractorFor('clip.mp4', 'video/mp4')).toBeNull();
    expect(extractorFor('archive.zip', 'application/zip')).toBeNull();
    expect(extractorFor('blob', 'application/octet-stream')).toBeNull();
  });
});

describe('extractText', () => {
  it('reads a PDF with -layout so tables survive', async () => {
    const { run, calls } = recorder(ok('Amount due  €42.00\nInvoice  INV-0001\n'));
    const res = await extractText('/inbox/bill.pdf', 'bill.pdf', 'application/pdf', { run, maxPages: 20 });

    expect(res?.tool).toBe('pdftotext');
    expect(res?.text).toContain('€42.00');
    expect(calls[0]).toEqual(['pdftotext', '-layout', '-l', '20', '/inbox/bill.pdf', '-']);
  });

  it('converts office formats with pandoc', async () => {
    const { run, calls } = recorder(ok('Employment agreement'));
    const res = await extractText('/inbox/c.docx', 'c.docx', undefined, { run });

    expect(res?.tool).toBe('pandoc');
    expect(calls[0]).toEqual(['pandoc', '/inbox/c.docx', '-t', 'plain']);
  });

  it('OCRs an image', async () => {
    const { run, calls } = recorder(ok('Corner Market  12.40 EUR'));
    const res = await extractText('/inbox/r.jpg', 'r.jpg', 'image/jpeg', { run });

    expect(res?.tool).toBe('tesseract');
    expect(calls[0]![0]).toBe('tesseract');
    expect(calls[0]).toContain('stdout');
  });

  it('reads a plain text file off disk without spawning anything', async () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, '  remember the milk  ');
    const { run, calls } = recorder(ok('unused'));

    const res = await extractText(file, 'notes.txt', 'text/plain', { run });
    expect(res).toEqual({ text: 'remember the milk', tool: 'read' });
    expect(calls).toHaveLength(0);
  });

  it('returns null rather than throwing when the tool fails', async () => {
    const { run } = recorder(fail('pdftotext: command not found'));
    expect(await extractText('/inbox/bill.pdf', 'bill.pdf', 'application/pdf', { run })).toBeNull();
  });

  it('returns null on a timeout', async () => {
    const { run } = recorder(fail('', true));
    expect(await extractText('/inbox/bill.pdf', 'bill.pdf', 'application/pdf', { run })).toBeNull();
  });

  it('treats an empty text layer as no text — the scanned-PDF signal', async () => {
    const { run } = recorder(ok('   \n \n'));
    expect(await extractText('/inbox/scan.pdf', 'scan.pdf', 'application/pdf', { run })).toBeNull();
  });

  it('returns null for a file with no extractor, without spawning', async () => {
    const { run, calls } = recorder(ok('x'));
    expect(await extractText('/inbox/v.mp4', 'v.mp4', 'video/mp4', { run })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reads a missing plain-text file as null', async () => {
    expect(await extractText(path.join(dir, 'nope.txt'), 'nope.txt', 'text/plain')).toBeNull();
  });
});

describe('pdfPageCount', () => {
  it('parses the Pages line', async () => {
    const { run } = recorder(ok('Title:  Bill\nPages:          3\nPage size: 595 x 842 pts\n'));
    expect(await pdfPageCount('/inbox/bill.pdf', { run })).toBe(3);
  });

  it('degrades to null when pdfinfo is unavailable or silent', async () => {
    expect(await pdfPageCount('/inbox/bill.pdf', { run: recorder(fail()).run })).toBeNull();
    expect(await pdfPageCount('/inbox/bill.pdf', { run: recorder(ok('Title: Bill\n')).run })).toBeNull();
  });
});

describe('renderPdfPages', () => {
  it('returns the rendered pages in page order', async () => {
    const outDir = path.join(dir, 'render');
    const run: RunFn = async () => {
      fs.mkdirSync(outDir, { recursive: true });
      // pdftoppm zero-pads, which is why the sort is lexical-safe.
      for (const n of ['scan-page-1.png', 'scan-page-2.png']) fs.writeFileSync(path.join(outDir, n), 'png');
      return ok('');
    };

    const pages = await renderPdfPages('/inbox/scan.pdf', outDir, 2, { run });
    expect(pages.map((p) => path.basename(p))).toEqual(['scan-page-1.png', 'scan-page-2.png']);
  });

  it('caps at the requested page count', async () => {
    const outDir = path.join(dir, 'render-cap');
    const run: RunFn = async () => {
      fs.mkdirSync(outDir, { recursive: true });
      for (const n of ['s-page-1.png', 's-page-2.png', 's-page-3.png']) {
        fs.writeFileSync(path.join(outDir, n), 'png');
      }
      return ok('');
    };

    expect(await renderPdfPages('/inbox/s.pdf', outDir, 2, { run })).toHaveLength(2);
  });

  it('returns nothing when pdftoppm fails', async () => {
    expect(await renderPdfPages('/inbox/s.pdf', path.join(dir, 'x'), 2, { run: recorder(fail()).run })).toEqual([]);
  });
});

describe('looksLikeRealText', () => {
  it('accepts extracted document text', () => {
    expect(looksLikeRealText('Amount due €42.00 — invoice INV-0001, billing period 2 April 2031.')).toBe(true);
    expect(looksLikeRealText('Corner Market\nTotal 12.40 EUR\nVISA ****0000')).toBe(true);
  });

  it('rejects the punctuation soup OCR returns for a photo with no text', () => {
    expect(looksLikeRealText('~~ ,, .. \\|/ ^^^ ` `` ~~~~ ||| ,,,, ....')).toBe(false);
    expect(looksLikeRealText('')).toBe(false);
    expect(looksLikeRealText('a b c')).toBe(false);
    expect(looksLikeRealText('   \n  ')).toBe(false);
  });
});

describe('runCommand', () => {
  it('captures stdout and a zero exit', async () => {
    const res = await runCommand('echo', ['hello'], 5000);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.timedOut).toBe(false);
  });

  it('reports a non-zero exit without throwing', async () => {
    const res = await runCommand('sh', ['-c', 'echo oops >&2; exit 3'], 5000);
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('oops');
  });

  it('kills a command that overruns its timeout', async () => {
    const res = await runCommand('sleep', ['5'], 150);
    expect(res.timedOut).toBe(true);
    expect(res.status).not.toBe(0);
  });

  it('reports a missing binary as a failure, not an exception', async () => {
    const res = await runCommand('luna-no-such-binary', [], 5000);
    expect(res.status).not.toBe(0);
  });
});
