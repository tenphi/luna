/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';
import type { InMemorySessionClient } from '../session/client.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo, setCurrentTaskRun } from '../current-batch.js';
import { isProcessUpdateResult } from '../reply-contract.js';
import { sendFile, sendMessage } from './core.js';

let client: InMemorySessionClient;

beforeEach(() => {
  client = installTestSessionClient();
  client.routing = { channel_type: 'telegram', platform_id: 'telegram:123', thread_id: null };
  client.destinations.push({
    name: 'current-chat',
    display_name: 'Current chat',
    type: 'channel',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    agent_group_id: null,
  });
  // Seed a peer agent destination.
  client.destinations.push({
    name: 'peer',
    display_name: 'Peer',
    type: 'agent',
    channel_type: null,
    platform_id: null,
    agent_group_id: 'ag-peer',
  });
});

afterEach(() => {
  clearCurrentInReplyTo();
  setCurrentTaskRun(null);
  resetTestSessionClient();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0].in_reply_to).toBeNull();
  });

  it('emits an ephemeral status note for the current conversation instead of a chat row', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ text: 'On it…' });

    // Notes are progress hints, so they must not reach the durable queue.
    expect(client.outbound).toHaveLength(0);
    expect(client.statusEvents).toHaveLength(1);
    expect(client.statusEvents[0].payload).toEqual({ phase: 'note', text: 'On it…' });
    expect(client.statusEvents[0].channelType).toBe('telegram');
    expect(client.statusEvents[0].platformId).toBe('telegram:123');
    expect(client.statusEvents[0].inReplyTo).toBe('inbound-msg-1');
  });

  it('marks the current-conversation note as undelivered so the runner still owes a reply', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    const res = await sendMessage.handler({ text: 'Here are the three champagnes…' });
    const text = JSON.stringify(res);

    // The result used to read "Message sent", which models took as the answer
    // being delivered — it is not, the note dies with the progress bubble.
    expect(isProcessUpdateResult(text)).toBe(true);
    expect(text).not.toContain('Message sent');
  });

  it('does not mark a real cross-destination send as a process update', async () => {
    const res = await sendMessage.handler({ to: 'peer', text: 'hello' });

    expect(isProcessUpdateResult(JSON.stringify(res))).toBe(false);
  });

  it('writes chat row for non-current destinations', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0].kind).toBe('chat');
    expect(JSON.parse(client.outbound[0].content)).toEqual({ text: 'hello' });
  });

  it('durably sends to an explicitly named destination even when it is the current conversation', async () => {
    setCurrentInReplyTo('scheduled-task-1');

    const res = await sendMessage.handler({ to: 'current-chat', text: 'The full morning briefing' });

    expect(client.statusEvents).toHaveLength(0);
    expect(client.outbound).toHaveLength(1);
    expect(client.outbound[0].in_reply_to).toBe('scheduled-task-1');
    expect(JSON.parse(client.outbound[0].content)).toEqual({ text: 'The full morning briefing' });
    expect(isProcessUpdateResult(JSON.stringify(res))).toBe(false);
  });

  it('requires a source decision before delivering a named scheduled report', async () => {
    setCurrentTaskRun({
      seriesId: 'daily',
      runId: 'scheduled-task-1',
      scheduledFor: '2031-04-03T07:00:00Z',
      prompt: 'Invented email digest',
      recurrence: null,
    });
    const rejected = await sendMessage.handler({ to: 'current-chat', text: 'The report' });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('source_email_ids');
    expect(client.outbound).toHaveLength(0);
    const accepted = await sendMessage.handler({
      to: 'current-chat',
      text: 'No email findings.',
      source_email_ids: [],
    });
    expect(accepted.isError).not.toBe(true);
    expect(client.outbound).toHaveLength(1);
  });

  it('carries selected email references with a durable scheduled report without putting them in the visible text', async () => {
    setCurrentInReplyTo('scheduled-task-1');
    await sendMessage.handler({
      to: 'current-chat',
      text: 'A proposed review remains unconfirmed.',
      source_email_ids: ['ada:111'],
    });
    expect(client.outbound[0].in_reply_to).toBe('scheduled-task-1');
    expect(JSON.parse(client.outbound[0].content)).toEqual({
      text: 'A proposed review remains unconfirmed.',
      source_email_ids: ['ada:111'],
    });
  });

  it('refuses to discard email evidence in an ephemeral progress note', async () => {
    const res = await sendMessage.handler({ text: 'A sourced report', source_email_ids: ['ada:111'] });
    expect(res.isError).toBe(true);
    expect(client.outbound).toHaveLength(0);
    expect(client.statusEvents).toHaveLength(0);
  });

  it('carries an exact report excerpt and rejects fabricated finding references', async () => {
    const text = 'The proposed review remains unconfirmed.';
    const findings = [{ text, source_email_ids: ['ada:111'] }];
    const result = await sendMessage.handler({
      to: 'current-chat',
      text,
      source_email_ids: ['ada:111'],
      source_email_findings: findings,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(client.outbound[0].content).source_email_findings).toEqual(findings);
    expect(
      (
        await sendMessage.handler({
          to: 'current-chat',
          text,
          source_email_ids: ['ada:111', 'ada:222'],
          source_email_findings: findings,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await sendMessage.handler({
          to: 'current-chat',
          text,
          source_email_ids: ['ada:111'],
          source_email_findings: [{ text: 'Confirmed booking.', source_email_ids: ['ada:111'] }],
        })
      ).isError,
    ).toBe(true);
    expect(client.outbound).toHaveLength(1);
  });

  it('identifies Markdown excerpt mismatches and queues only the corrected report', async () => {
    const first = '**Ada — Bo:** Payment **EUR 25** is pending.';
    const second = 'A visit to *The Studio* remains unconfirmed.';
    const text = `## Daily digest\n\n- ${first}\n- ${second}`;
    const args = {
      to: 'current-chat', text, source_email_ids: ['ada:111', 'ada:222'],
      source_email_findings: [
        { text: 'Ada — Bo: Payment EUR 25 is pending.', source_email_ids: ['ada:111'] },
        { text: 'A visit to The Studio remains unconfirmed.', source_email_ids: ['ada:222'] },
      ],
    };
    const rejected = await sendMessage.handler(args);
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain('source_email_findings[0].text');
    expect(JSON.stringify(rejected)).toContain('source_email_findings[1].text');
    expect(JSON.stringify(rejected)).toContain('including Markdown markers');
    expect(JSON.stringify(rejected)).toContain('no message has been queued');
    expect(client.outbound).toHaveLength(0);

    const accepted = await sendMessage.handler({ ...args, source_email_findings: [
      { text: first, source_email_ids: ['ada:111'] },
      { text: second, source_email_ids: ['ada:222'] },
    ] });
    expect(accepted.isError).not.toBe(true);
    expect(client.outbound).toHaveLength(1);
    expect(JSON.parse(client.outbound[0].content).text).toBe(text);
    expect(JSON.parse(client.outbound[0].content).source_email_findings.map((f: { text: string }) => f.text)).toEqual([first, second]);
  });

  it('rejects hidden internal excerpts before the host delivery boundary', async () => {
    const result = await sendMessage.handler({
      to: 'current-chat', text: 'Visible.<internal>Hidden proposal.</internal>',
      source_email_ids: ['ada:111'],
      source_email_findings: [{ text: 'Hidden proposal.', source_email_ids: ['ada:111'] }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('do not quote <internal> text');
    expect(client.outbound).toHaveLength(0);
  });

  it.each([['a thread URL'], ['ada:xyz'], Array(21).fill('ada:111'), 'ada:111'])(
    'refuses invalid or oversized email reference lists before delivery: %j',
    async (source_email_ids) => {
      const res = await sendMessage.handler({ to: 'current-chat', text: 'Report', source_email_ids });
      expect(res.isError).toBe(true);
      expect(client.outbound).toHaveLength(0);
    },
  );
});

/**
 * `path` used to accept any absolute path, so a memory-rooted one was a silent
 * success that skipped every size, policy, and journal check. These cover the
 * refusals, which all happen before anything is written to the outbox.
 */
describe('send_file — source resolution', () => {
  let memory: string;

  beforeEach(() => {
    memory = fs.mkdtempSync(path.join(os.tmpdir(), 'send-memory-'));
    process.env.LUNA_MEMORY_PATH = memory;
  });

  afterEach(() => {
    delete process.env.LUNA_MEMORY_PATH;
    fs.rmSync(memory, { recursive: true, force: true });
  });

  it('rejects an absolute path inside the memory and names the right move', async () => {
    const photo = path.join(memory, 'documents', 'passport.jpg');
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, 'jpegbytes');

    const res = await sendFile.handler({ to: 'peer', path: photo });
    expect(JSON.stringify(res)).toContain('use `memory:');
    expect(client.outbound).toHaveLength(0);
  });

  it('rejects a memory: id passed as path, and both params at once', async () => {
    const asPath = await sendFile.handler({ to: 'peer', path: 'memory:documents/passport.jpg' });
    expect(JSON.stringify(asPath)).toContain('pass it as `memory`');

    const both = await sendFile.handler({ to: 'peer', path: 'a.jpg', memory: 'memory:a.jpg' });
    expect(JSON.stringify(both)).toContain('not both');

    const neither = await sendFile.handler({ to: 'peer' });
    expect(JSON.stringify(neither)).toContain('required');
    expect(client.outbound).toHaveLength(0);
  });

  it('sends stored originals through the host with no memory mount and keeps reply routing', async () => {
    delete process.env.LUNA_MEMORY_PATH;
    const staged: Array<{ document: string; id: string; filename?: string }> = [];
    client.stageMemoryFile = async (document, id, filename) => {
      staged.push({ document, id, filename });
      return { filename: filename ?? 'scan.jpg' };
    };
    setCurrentInReplyTo('inbound-files');

    await sendFile.handler({ to: 'current-chat', memory: 'doc-first', text: 'First scan' });
    await sendFile.handler({ to: 'current-chat', memory: 'memory:documents/scan-2.pdf', filename: 'second.pdf' });

    expect(staged.map((entry) => entry.document)).toEqual(['doc-first', 'memory:documents/scan-2.pdf']);
    expect(client.outbound).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(client.outbound[i].id).toBe(staged[i].id);
      expect(client.outbound[i].in_reply_to).toBe('inbound-files');
      expect(client.outbound[i].platform_id).toBe('telegram:123');
    }
    expect(JSON.parse(client.outbound[0].content)).toEqual({ text: 'First scan', files: ['scan.jpg'] });
    expect(JSON.parse(client.outbound[1].content)).toEqual({ text: '', files: ['second.pdf'] });
  });

  it('reports a host retrieval failure without queuing a message', async () => {
    client.stageMemoryFile = async () => ({ error: 'The original file is missing.' });
    const res = await sendFile.handler({ to: 'peer', memory: 'doc-missing' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('original file is missing');
    expect(client.outbound).toHaveLength(0);
  });

  it('refuses a workspace file over the 50MB messaging limit', async () => {
    delete process.env.LUNA_MEMORY_PATH;
    const big = path.join(memory, 'scan.pdf');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 60 * 1024 * 1024);

    const res = await sendFile.handler({ to: 'peer', path: big });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('50MB');
    expect(client.outbound).toHaveLength(0);
  });
});
