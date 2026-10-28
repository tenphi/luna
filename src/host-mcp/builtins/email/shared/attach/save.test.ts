import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentMeta } from '../types.js';

let sessionRoot: string;

// The workspace mapping is exercised by its own tests; here it just has to point somewhere real so
// the traversal and collision behaviour can be checked against an actual filesystem.
vi.mock('../../../../workspace-paths.js', () => ({
  WORKSPACE: '/workspace',
  translateWorkspacePath: (containerPath: string) =>
    sessionRoot ? { hostPath: path.join(sessionRoot, containerPath.replace('/workspace/', '')), containerPath } : null,
}));

const { saveToWorkspace } = await import('./save.js');

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return { attachmentId: '2', filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 4, ...overrides };
}

const caller = { agentGroupId: 'g', sessionId: 's' };

beforeEach(() => {
  sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-save-test-'));
});

afterEach(() => {
  fs.rmSync(sessionRoot, { recursive: true, force: true });
});

describe('saveToWorkspace', () => {
  it('writes the file and returns a container path, never a host path', () => {
    const saved = saveToWorkspace(meta(), Buffer.from('pdf!'), caller);

    expect(saved.containerPath).toBe('/workspace/inbox/mail/invoice.pdf');
    expect(saved.containerPath).not.toContain(sessionRoot);
    expect(fs.readFileSync(path.join(sessionRoot, 'inbox/mail/invoice.pdf'), 'utf-8')).toBe('pdf!');
  });

  it('refuses a filename that navigates out of the directory', () => {
    const saved = saveToWorkspace(meta({ filename: '../../../../etc/passwd' }), Buffer.from('x'), caller);

    expect(saved.filename).not.toContain('..');
    expect(saved.filename).toBe('attachment-2.pdf');
    expect(fs.existsSync(path.join(sessionRoot, 'inbox/mail/attachment-2.pdf'))).toBe(true);
  });

  it('keeps the extension when falling back, so memory ingest still dispatches', () => {
    const saved = saveToWorkspace(meta({ filename: '', mimeType: 'image/png' }), Buffer.from('x'), caller);

    expect(saved.filename.endsWith('.png')).toBe(true);
  });

  it('does not clobber a file already saved under the same name', () => {
    saveToWorkspace(meta(), Buffer.from('first'), caller);
    const second = saveToWorkspace(meta(), Buffer.from('second'), caller);

    expect(second.filename).toBe('invoice-2.pdf');
    expect(fs.readFileSync(path.join(sessionRoot, 'inbox/mail/invoice.pdf'), 'utf-8')).toBe('first');
  });

  it('says which tool to use instead when there is no workspace', () => {
    sessionRoot = '';

    expect(() => saveToWorkspace(meta(), Buffer.from('x'), undefined)).toThrow(/read_attachment/);
  });
});
