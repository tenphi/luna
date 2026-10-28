/** Opt-in model check with invented mail and mocked delivery; never reads or writes live memory. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PublicEvalProvider, writeEvalResults, type EvalResult } from './public-context.js';
import type { OpenAITool } from '../providers/openai/tools/builtin.js';
import { setSessionsDirForTests } from '../providers/openai/session-store.js';
import type { ProviderEvent } from '../providers/types.js';
import { installTestSessionClient, resetTestSessionClient, seedChannelDestination } from '../session/test-support.js';
import { sendMessage } from '../mcp-tools/core.js';
import { setCurrentTaskRun } from '../current-batch.js';

type Call = { name: string; args: Record<string, unknown>; rejected?: boolean };
const BODY =
  'Ada, the proposed review is tomorrow at 10:00. EUR 1111 remains pending, not settled. ' +
  'No booking is confirmed. Please reply if you accept; this email does not record acceptance.';
const TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'read_thread',
      description: 'Read an email conversation with original message IDs and dates.',
      parameters: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_message',
      description: 'Continue a truncated email body.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, offset: { type: 'number' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: sendMessage.tool.name,
      description: sendMessage.tool.description ?? 'Send a message.',
      parameters: sendMessage.tool.inputSchema,
    },
  },
];

class MockMail {
  calls: Call[] = [];
  rejectedMissingEvidence = false;
  rejectedMarkdownExcerpt = false;
  constructor(readonly mode: 'complete' | 'truncated' | 'formatted' | 'empty') {}
  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const call: Call = { name, args };
    this.calls.push(call);
    if (name === 'send_message') {
      // Exercise the real delivery guard once, even when the model initially chose IDs.
      let sentArgs = this.rejectedMissingEvidence ? args : { ...args, source_email_ids: undefined };
      const injectMarkdownMismatch =
        this.mode === 'formatted' && this.rejectedMissingEvidence && !this.rejectedMarkdownExcerpt;
      if (injectMarkdownMismatch && Array.isArray(args.source_email_findings)) {
        sentArgs = {
          ...args,
          source_email_findings: args.source_email_findings.map((finding) => ({
            ...finding,
            text: String(finding.text).replace(/\*/g, ''),
          })),
        };
      }
      const result = await sendMessage.handler(sentArgs);
      call.rejected = result.isError === true;
      if (injectMarkdownMismatch && call.rejected) this.rejectedMarkdownExcerpt = true;
      if (call.rejected && !this.rejectedMissingEvidence) this.rejectedMissingEvidence = true;
      return JSON.stringify(result);
    }
    if (name === 'read_message' && args.id === 'ada:111') {
      return JSON.stringify({
        id: 'ada:111',
        from: 'Bo Winters <bo@example.test>',
        to: ['ada@example.test'],
        date: '2031-04-02T20:30:00+02:00',
        body: BODY,
        removed: { truncatedChars: 0 },
      });
    }
    if (name === 'read_thread' && args.threadId === 'ada:100') {
      return JSON.stringify({
        subject: 'Proposed review',
        messages: [
          {
            id: 'ada:111',
            from: 'Bo Winters <bo@example.test>',
            to: ['ada@example.test'],
            date: '2031-04-02T20:30:00+02:00',
            body:
              this.mode === 'truncated'
                ? 'Ada, the proposed review is tomorrow. [Continue with read_message({id:"ada:111", offset:43})]'
                : BODY,
            removed: { truncatedChars: this.mode === 'truncated' ? 150 : 0 },
          },
        ],
      });
    }
    if (name === 'read_thread' && args.threadId === 'ada:200') {
      return JSON.stringify({
        subject: 'General newsletter',
        messages: [
          {
            id: 'ada:222',
            from: 'Newsletter <news@example.test>',
            to: ['ada@example.test'],
            date: '2031-04-02T12:00:00+02:00',
            body: 'General news: citywide spring promotions. No personal orders, payments or account events.',
            removed: { truncatedChars: 0 },
          },
        ],
      });
    }
    return 'Error: unknown source or tool';
  }
}

class EvalProvider extends PublicEvalProvider {
  constructor(private mail: MockMail) {
    super();
  }
  protected async ensureTools(): Promise<OpenAITool[]> {
    return TOOLS;
  }
  protected async dispatchTool(name: string, args: Record<string, unknown>): Promise<string> {
    return this.mail.dispatch(name, args);
  }
}

function check(mail: MockMail): string[] {
  const reports = mail.calls.filter(
    (call) => call.name === 'send_message' && call.args.to === 'owner' && !call.rejected,
  );
  const text = reports.map((call) => String(call.args.text ?? '')).join('\n');
  const ids = reports.flatMap((call) => (Array.isArray(call.args.source_email_ids) ? call.args.source_email_ids : []));
  const issues: string[] = [];
  if (!mail.rejectedMissingEvidence) issues.push('Missing evidence decision was not rejected');
  if (!reports.length) issues.push('Report was not delivered to the named destination');
  if (ids.includes('ada:222')) issues.push('Routine newsletter was selected for memory');
  if (text.includes('ada:111') || text.includes('ada:222'))
    issues.push('Opaque source IDs leaked into the visible report');
  if (mail.mode === 'empty') {
    if (ids.length) issues.push('An empty check attached personal evidence');
    return issues;
  }
  if (!ids.includes('ada:111')) issues.push('Personal finding has no original source reference');
  if (mail.mode === 'formatted') {
    if (!mail.rejectedMarkdownExcerpt) issues.push('Rendered Markdown excerpt was not rejected');
    if (!/\*\*[^*]*(?:1111|1[,. ]111)[^*]*\*\*/.test(text))
      issues.push('The corrected report lost its requested bold amount');
  }
  const findings = reports.flatMap((call) =>
    Array.isArray(call.args.source_email_findings) ? call.args.source_email_findings : [],
  );
  if (!findings.some((finding) => finding.source_email_ids?.includes('ada:111') && text.includes(finding.text)))
    issues.push('Personal finding has no exact report excerpt linked to its original');
  if (!/Ada/i.test(text) || !/Bo Winters/i.test(text)) issues.push('Person or original reporter was lost');
  if (!/1111|1[,. ]111/.test(text) || !/EUR|€/.test(text)) issues.push('Transaction amount or currency was lost');
  if (!/pending|not settled|unsettled/i.test(text)) issues.push('Pending payment qualification was lost');
  if (!/propos|unconfirmed|not confirmed|no .*confirm|not .*book|no booking/i.test(text))
    issues.push('Proposal/booking qualification was lost');
  if (!/2031-04-03|3 April|April 3|3 Apr\b|Apr 3\b/i.test(text))
    issues.push('Relative event date was not resolved from the original source date');
  const sourceRead = mail.calls.findIndex((call) => call.name === 'read_thread' && call.args.threadId === 'ada:100');
  const delivery = mail.calls.findIndex(
    (call) => call.name === 'send_message' && call.args.to === 'owner' && !call.rejected,
  );
  if (sourceRead < 0 || sourceRead >= delivery) issues.push('Personal source body was not read before reporting');
  if (mail.mode === 'truncated') {
    const continuation = mail.calls.findIndex((call) => call.name === 'read_message' && call.args.id === 'ada:111');
    if (continuation < 0 || continuation >= delivery)
      issues.push('Truncated source was not completed before reporting');
  }
  return issues;
}

const instructions = [
  'You are Luna. The owner is Ada Marlow, ada@example.test. Her named delivery destination is owner. ' +
    'This scheduled run is at 09:00 on 3 April 2031, Europe/Berlin.',
  fs.readFileSync(path.resolve(import.meta.dir, '../../../skills/email/SKILL.md'), 'utf8'),
].join('\n\n');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-digest-eval-'));
setSessionsDirForTests(path.join(temp, 'sessions'));
let failures = 0;
const results: EvalResult[] = [];
try {
  for (const mode of ['complete', 'truncated', 'formatted', 'empty'] as const) {
    const started = performance.now();
    const client = installTestSessionClient();
    client.routing = { channel_type: 'telegram', platform_id: 'telegram:111', thread_id: null };
    seedChannelDestination(client, { name: 'owner', channel_type: 'telegram', platform_id: 'telegram:111' });
    setCurrentTaskRun({
      seriesId: 'daily',
      runId: `invented-${mode}`,
      scheduledFor: '2031-04-03T07:00:00Z',
      prompt: 'Invented daily digest',
      recurrence: null,
    });
    const mail = new MockMail(mode);
    const provider = new EvalProvider(mail);
    const query = provider.query({
      cwd: temp,
      systemContext: { instructions },
      senderIsPrivileged: true,
      prompt:
        '<task scheduled_for="2031-04-03T09:00:00+02:00">Review the emails from 2 April and send the daily digest to owner. ' +
        'Search already completed, coverage.complete=true. ' +
        (mode === 'empty'
          ? 'The only thread is the general newsletter ada:200.'
          : 'The threads to review are Proposed review ada:100 and General newsletter ada:200.') +
        (mode === 'formatted'
          ? ' Use Markdown bold for the payment amount and italics for the proposed review in the report and its exact finding excerpt.'
          : '') +
        '</task>',
    });
    query.end();
    for await (const _event of query.events as AsyncIterable<ProviderEvent>) {
      /* Drain the real model turn. */
    }
    const issues = check(mail);
    if (client.outbound.length !== mail.calls.filter((call) => call.name === 'send_message' && !call.rejected).length)
      issues.push('Rejected report wrote an outbound message');
    results.push({
      name: mode,
      passed: !issues.length,
      problems: issues,
      elapsedMs: Math.round(performance.now() - started),
      toolCalls: mail.calls.length,
      usage: provider.metrics,
    });
    console.log(`${issues.length ? 'FAIL' : 'PASS'} ${mode}: ${mail.calls.map((call) => call.name).join(' → ')}`);
    for (const issue of issues) console.log(`  - ${issue}`);
    if (issues.length) {
      console.log(JSON.stringify(mail.calls));
      failures += 1;
    }
  }
} finally {
  writeEvalResults('scheduled-digest', results);
  setCurrentTaskRun(null);
  setSessionsDirForTests(null);
  resetTestSessionClient();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`${4 - failures}/4 scheduled digest scenarios passed`);
if (failures) process.exitCode = 1;
