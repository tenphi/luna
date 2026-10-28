import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearCurrentInReplyTo, setCurrentInReplyTo, setCurrentTaskRun } from '../../../current-batch.js';
import { McpBridge } from './mcp-bridge.js';

describe('Luna MCP context across the stdio process boundary', () => {
  it('correlates delivered reports, isolates overlapping calls, and clears the next turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-mcp-context-'));
    const output = path.join(dir, 'outbound.jsonl');
    const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
    // The real tool/server run in a separate process, with only session IO replaced.
    // Calling handlers in this test process would hide the missing-context failure.
    fs.writeFileSync(path.join(dir, 'server.ts'), `
      import fs from 'node:fs';
      import { InMemorySessionClient, setSessionClient } from ${moduleUrl('../../../session/client.ts')};
      import { getCurrentTaskRun } from ${moduleUrl('../../../current-batch.ts')};
      import { startMcpServer } from ${moduleUrl('../../../mcp-tools/server.ts')};
      import ${moduleUrl('../../../mcp-tools/core.ts')};
      import ${moduleUrl('../../../mcp-tools/scheduling.ts')};
      const client = new InMemorySessionClient();
      client.routing = { channel_type: 'telegram', platform_id: 'invented-chat', thread_id: null };
      client.destinations.push({ name: 'owner', type: 'channel', channel_type: 'telegram', platform_id: 'invented-chat', display_name: null, agent_group_id: null });
      let seq = 0;
      client.writeMessageOut = async (msg) => {
        fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({ ...msg, taskRun: getCurrentTaskRun() }) + '\\n');
        return ++seq;
      };
      setSessionClient(client);
      await startMcpServer();
    `);
    const bridge = new McpBridge();
    const taskRun = { runId: 'run-a', seriesId: 'series-a', scheduledFor: '2031-04-03T08:00:00Z', prompt: 'Review the household sources.', recurrence: '0 8 * * *' };
    try {
      await bridge.connect({ luna: { command: process.execPath, args: [path.join(dir, 'server.ts')], env: {} } });
      expect(bridge.hasConnectedServer('luna')).toBe(true);
      setCurrentInReplyTo(taskRun.runId);
      setCurrentTaskRun(taskRun);
      const report = 'Vulpine Mutual reports that Ada Marlow renewed the policy on 2 April 2031.';
      expect(await bridge.call('send_message', { to: 'owner', text: report, source_email_ids: [] })).toContain('Message sent');
      expect(await bridge.call('schedule_task', { prompt: taskRun.prompt, recurrence: taskRun.recurrence, processAfter: '2031-04-04T08:00:00Z' })).toContain('already running');

      setCurrentInReplyTo('run-b');
      setCurrentTaskRun({ ...taskRun, runId: 'run-b' });
      const first = bridge.call('send_message', { to: 'owner', text: 'First overlapping report.', source_email_ids: [] });
      setCurrentInReplyTo('run-c');
      setCurrentTaskRun({ ...taskRun, runId: 'run-c' });
      const second = bridge.call('send_message', { to: 'owner', text: 'Second overlapping report.', source_email_ids: [] });
      await Promise.all([first, second]);

      clearCurrentInReplyTo();
      setCurrentTaskRun(null);
      expect(await bridge.callRaw('luna', 'send_message', { to: 'owner', text: 'An unrelated message.' })).toContain('Message sent');
      const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ in_reply_to: 'run-a', taskRun, content: JSON.stringify({ text: report, source_email_ids: [] }) });
      expect(rows.slice(1, 3).map((row) => [JSON.parse(row.content).text, row.in_reply_to, row.taskRun.runId])).toEqual([
        ['First overlapping report.', 'run-b', 'run-b'],
        ['Second overlapping report.', 'run-c', 'run-c'],
      ]);
      expect(rows[3]).toMatchObject({ in_reply_to: null, taskRun: null });
    } finally {
      clearCurrentInReplyTo();
      setCurrentTaskRun(null);
      await bridge.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
