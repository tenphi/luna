import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The only place a container path becomes a host path.
 *
 * `memory_ingest` runs on the host and is handed `/workspace/inbox/m-42/bill.pdf`, which
 * exists only inside the sandbox — so ingesting an attachment failed with `not_found` on a
 * file the agent could see. What is asserted here is the translation *and* its two limits:
 * it must not escape the mount, and the host path must not travel back.
 */
let dataDir: string;
let agentDir: string;

vi.mock('../install-paths.js', () => ({ getAgentDir: () => agentDir }));
vi.mock('../session-manager.js', () => ({
  sessionDir: (agentGroupId: string, sessionId: string) => path.join(dataDir, 'sessions', agentGroupId, sessionId),
}));

const { hideHostPath, isWorkspacePath, translateWorkspacePath } = await import('./workspace-paths.js');

const CALLER = { agentGroupId: 'grp-1', sessionId: 'sess-1' };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-ws-data-'));
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-ws-agent-'));
  fs.mkdirSync(path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42/bill.pdf'), 'bytes');
});

afterEach(() => {
  for (const dir of [dataDir, agentDir]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('translateWorkspacePath', () => {
  it('resolves an inbound attachment to the session folder it is mounted from', () => {
    const result = translateWorkspacePath('/workspace/inbox/m-42/bill.pdf', CALLER);
    expect(result?.hostPath).toBe(path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42/bill.pdf'));
    expect(fs.existsSync(result!.hostPath)).toBe(true);
  });

  it('sends /workspace/agent to the agent directory, not into the session', () => {
    // Two different mounts, and the longer prefix is a *different host directory* rather
    // than a subfolder of the shorter one. Matching shortest-first puts the file in a
    // folder that does not hold it.
    fs.writeFileSync(path.join(agentDir, 'report.pdf'), 'bytes');
    const result = translateWorkspacePath('/workspace/agent/report.pdf', CALLER);
    expect(result?.hostPath).toBe(path.join(agentDir, 'report.pdf'));
  });

  it('leaves a host path or a URL alone', () => {
    expect(translateWorkspacePath('/Users/example/notes.pdf', CALLER)).toBeNull();
    expect(translateWorkspacePath('https://example.com/a.pdf', CALLER)).toBeNull();
    expect(isWorkspacePath('/workspaces/other')).toBe(false);
  });

  it('refuses to climb out of the mount', () => {
    expect(translateWorkspacePath('/workspace/../../../etc/passwd', CALLER)).toBeNull();
    expect(translateWorkspacePath('/workspace/inbox/../../../../etc/passwd', CALLER)).toBeNull();
  });

  it('refuses a symlink pointing out of the mount', () => {
    // A prefix test answers a question about strings. The file is inside the session folder
    // either way; only the real path says whether the bytes are.
    const secret = path.join(dataDir, 'secret.txt');
    fs.writeFileSync(secret, 'private');
    fs.symlinkSync(secret, path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42/escape.pdf'));
    expect(translateWorkspacePath('/workspace/inbox/m-42/escape.pdf', CALLER)).toBeNull();
  });

  it('cannot reach another group by naming a session', () => {
    // The token authenticates the group, so a claimed session id may only ever select a
    // folder underneath that group's own tree.
    expect(
      translateWorkspacePath('/workspace/x.pdf', { agentGroupId: 'grp-1', sessionId: '../grp-2/sess-9' }),
    ).toBeNull();
  });

  it('resolves nothing under /workspace without a session', () => {
    // A caller with no session has no session folder; guessing one would read another
    // conversation's inbox.
    expect(translateWorkspacePath('/workspace/inbox/m-42/bill.pdf', { agentGroupId: 'grp-1' })).toBeNull();
  });
});

describe('hideHostPath', () => {
  it('puts the agent’s own path back into what it reads', () => {
    const translation = {
      hostPath: '/Users/example/Library/luna/sessions/grp-1/sess-1/inbox/m-42/bill.pdf',
      containerPath: '/workspace/inbox/m-42/bill.pdf',
    };
    const text = hideHostPath(`no file at ${translation.hostPath}`, translation);
    expect(text).toBe('no file at /workspace/inbox/m-42/bill.pdf');
    expect(text).not.toContain('/Users/');
  });
});
