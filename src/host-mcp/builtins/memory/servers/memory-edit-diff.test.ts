import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ root: '' }));
vi.mock('../../../../session-manager.js', async () => {
  const { openSessionDb } = await import('../../../../db/session-db.js');
  return {
    sessionDbPath: (_group: string, session: string) => path.join(scope.root, `${session}.db`),
    openSession: (_group: string, session: string) => openSessionDb(path.join(scope.root, `${session}.db`)),
  };
});
import { ensureSchema, openSessionDb, insertMessage } from '../../../../db/session-db.js';
import { runAsCaller } from '../../../caller-context.js';
import { createMemoryMcpServer } from './memory.js';
let tool: {
  handler: (input: { id: string; offset?: number }) => Promise<{ content: { text: string }[]; isError?: boolean }>;
};
beforeEach(() => {
  scope.root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-edit-tool-'));
  for (const session of ['first', 'second']) ensureSchema(path.join(scope.root, `${session}.db`));
  const db = openSessionDb(path.join(scope.root, 'first.db'));
  try {
    insertMessage(db, {
      id: 'memory-edit:fixture',
      kind: 'memory_edit',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ file: 'notes/preferences.md', diff: 'Preview.', fullDiff: '- Morning\n+ Afternoon\n' }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } finally {
    db.close();
  }
  tool = (createMemoryMcpServer() as unknown as { _registeredTools: Record<string, typeof tool> })._registeredTools
    .edit_diff!;
});
afterEach(() => {
  fs.rmSync(scope.root, { recursive: true, force: true });
});
describe('session-scoped saved external diff tool', () => {
  it('reads a complete saved correction and refuses ids from another session', async () => {
    const own = await runAsCaller({ agentGroupId: 'fixture-agent', sessionId: 'first' }, () =>
      tool.handler({ id: 'memory-edit:fixture' }),
    );
    expect(JSON.parse(own.content[0].text)).toEqual({
      file: 'notes/preferences.md',
      diff: '- Morning\n+ Afternoon\n',
      nextOffset: null,
    });
    const other = await runAsCaller({ agentGroupId: 'fixture-agent', sessionId: 'second' }, () =>
      tool.handler({ id: 'memory-edit:fixture' }),
    );
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toContain('this session');
  });
  it('requires session identity and refuses filesystem traversal', async () => {
    expect((await tool.handler({ id: 'memory-edit:fixture' })).isError).toBe(true);
    const invalid = await runAsCaller({ agentGroupId: '../private', sessionId: 'first' }, () =>
      tool.handler({ id: 'memory-edit:fixture' }),
    );
    expect(invalid.isError).toBe(true);
  });
});
