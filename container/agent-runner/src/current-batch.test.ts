import { afterEach, describe, expect, it } from 'bun:test';
import { clearCurrentInReplyTo, currentBatchMeta, getCurrentInReplyTo, getCurrentTaskRun, setCurrentInReplyTo, setCurrentTaskRun, withMcpBatch } from './current-batch.js';

afterEach(() => {
  clearCurrentInReplyTo();
  setCurrentTaskRun(null);
});

describe('MCP batch metadata', () => {
  it('keeps private task context off external MCP requests', () => {
    setCurrentInReplyTo('turn-a');
    expect(currentBatchMeta('memory')).toBeUndefined();
    expect(currentBatchMeta('email')).toBeUndefined();
  });

  it('never inherits stale process context when metadata is absent or invalid', () => {
    setCurrentInReplyTo('stale-turn');
    withMcpBatch(undefined, () => {
      expect(getCurrentInReplyTo()).toBeNull();
      expect(getCurrentTaskRun()).toBeNull();
    });
    expect(() => withMcpBatch({ 'luna/batch': { inReplyTo: 123 } }, () => { throw new Error('must not run'); })).toThrow('Invalid Luna batch metadata');
    expect(getCurrentInReplyTo()).toBe('stale-turn');
  });

  it('isolates overlapping async handlers, including after a failed call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withMcpBatch({ 'luna/batch': { inReplyTo: 'first', taskRun: null } }, async () => {
      await gate;
      expect(getCurrentInReplyTo()).toBe('first');
    });
    await expect(withMcpBatch({ 'luna/batch': { inReplyTo: 'second', taskRun: null } }, async () => {
      expect(getCurrentInReplyTo()).toBe('second');
      release();
      throw new Error('tool failed');
    })).rejects.toThrow('tool failed');
    await first;
    expect(getCurrentInReplyTo()).toBeNull();
  });
});
