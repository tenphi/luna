import { afterEach, beforeEach, expect, it } from 'bun:test';
import { clearCurrentInReplyTo, setCurrentInReplyTo, setCurrentTaskRun } from '../current-batch.js';
import { installTestSessionClient, resetTestSessionClient } from '../session/test-support.js';
import type { InMemorySessionClient } from '../session/client.js';
import { scheduleTask, updateTask } from './scheduling.js';

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
