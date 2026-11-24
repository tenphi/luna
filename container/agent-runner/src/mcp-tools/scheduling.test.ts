import { afterEach, beforeEach, expect, it } from 'bun:test';
import { clearCurrentInReplyTo, setCurrentInReplyTo, setCurrentTaskRun } from '../current-batch.js';
import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';
import type { InMemorySessionClient } from '../session/client.js';
import { listTasks, scheduleTask, updateTask } from './scheduling.js';

let client: InMemorySessionClient;
beforeEach(() => {
  client = installTestSessionClient();
  client.routing = { channel_type: 'telegram', platform_id: 'telegram:1000000001', thread_id: 'topic-4' };
  setCurrentInReplyTo('request-7');
});
afterEach(() => {
  clearCurrentInReplyTo();
  setCurrentTaskRun(null);
  resetTestSessionClient();
});

it('gives retried scheduling calls the same host deduplication key and route', async () => {
  const input = { prompt: 'Check the shared calendar', processAfter: '2031-05-07T09:00:00+02:00' };
  await scheduleTask.handler(input);
  await scheduleTask.handler(input);
  expect(client.outbound).toHaveLength(2);
  expect(client.outbound[1].id).toBe(client.outbound[0].id);
  expect(JSON.parse(client.outbound[0].content)).toMatchObject({
    action: 'schedule_task',
    prompt: input.prompt,
    processAfter: '2031-05-07T07:00:00.000Z',
    channelType: 'telegram',
    platformId: 'telegram:1000000001',
    threadId: 'topic-4',
  });
});

it('keeps an executing recurring series from scheduling a duplicate of itself', async () => {
  setCurrentTaskRun({
    seriesId: 'morning-check',
    runId: 'occurrence-3',
    scheduledFor: '2031-05-07T07:00:00Z',
    prompt: 'Check the shared calendar',
    recurrence: '0 9 * * *',
  });
  await scheduleTask.handler({
    prompt: ' Check the   shared calendar ',
    recurrence: '0 9 * * *',
    processAfter: '2031-05-08T09:00:00+02:00',
  });
  expect(client.outbound).toHaveLength(0);
});

it('distinguishes clearing optional task fields from preserving omitted fields', async () => {
  await updateTask.handler({ taskId: 'morning-check', recurrence: '', status: 'paused' });
  expect(JSON.parse(client.outbound[0].content)).toEqual({
    action: 'update_task',
    taskId: 'morning-check',
    recurrence: null,
    status: 'paused',
  });
});

it('rejects invalid scheduling times before writing to the host queue', async () => {
  const result = await scheduleTask.handler({ prompt: 'Check the shared calendar', processAfter: 'not a date' });
  expect(result.isError).toBe(true);
  expect(client.outbound).toHaveLength(0);
});

const digestPrompt = [
  'Every morning, review the Blackwater Bay household mailboxes for the previous day.',
  'Summarise anything Ada Marlow or Bo Winters needs to act on, grouped by urgency.',
  'Skip newsletters unless they mention a Vulpine Mutual policy change.',
].join('\n');
const text = (result: { content: { text: string }[] }) => result.content[0].text;

it('marks shortened task instructions and points at the full view', async () => {
  client.seedInbound({ id: 'morning-digest', kind: 'task', recurrence: '0 9 * * *', process_after: '2031-05-08T07:00:00Z', content: JSON.stringify({ prompt: digestPrompt, script: null }) });
  const listing = text(await listTasks.handler({}));
  expect(listing).toContain('morning-digest [pending] at=2031-05-08T07:00:00Z recur=0 9 * * *');
  expect(listing).toContain(`… (${digestPrompt.length} chars)`);
  expect(listing).not.toContain('Vulpine Mutual');
  expect(listing).toContain('list_tasks with taskId');
});

it('shows one task series in full so its instructions can be edited without loss', async () => {
  client.seedInbound({ id: 'morning-digest', kind: 'task', recurrence: '0 9 * * *', content: JSON.stringify({ prompt: digestPrompt, script: 'echo \'{"wakeAgent":true}\'' }) });
  const full = text(await listTasks.handler({ taskId: 'morning-digest' }));
  expect(full).toContain(`Instructions:\n${digestPrompt}`);
  expect(full).toContain('Script:\necho');
  const missing = await listTasks.handler({ taskId: 'evening-digest' });
  expect(missing.isError).toBe(true);
});
