import { describe, expect, it } from 'vitest';

import { createEmailMcpServer } from './email.js';
import type { MailBackend } from '../shared/backend.js';
import type { MailConfig, ThreadSummary } from '../shared/types.js';

const config: MailConfig = {
  enabled: true,
  backend: 'gmail-imap',
  toolsAllow: [],
  maxBodyChars: 1000,
  mailboxes: [
    { key: 'ada', address: 'ada@example.test', displayName: null, appPassword: 'fixture' },
    { key: 'bo', address: 'bo@example.test', displayName: null, appPassword: 'fixture' },
  ],
  problems: [],
};

function thread(mailbox: string, id: string, latestMessageId?: string): ThreadSummary {
  return {
    threadId: id,
    mailbox,
    ...(latestMessageId ? { latestMessageId } : {}),
    subject: 'Fictional library notice',
    participants: ['author@example.test'],
    lastMessageAt: '2026-02-03T09:00:00.000Z',
    messageCount: 1,
    unread: true,
    hasAttachments: false,
    snippet: 'Opening hours changed.',
  };
}

async function search(backend: Partial<MailBackend>, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createEmailMcpServer(config, backend as MailBackend);
  const registered = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ text: string }> }> }>;
    }
  )._registeredTools;
  const result = await registered.search_mail!.handler(args);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('search_mail coverage', () => {
  it('pages the combined mailbox results without dropping a mailbox at the merge limit', async () => {
    const backend = {
      async searchThreadsWithCoverage(query: { mailbox: string; limit: number }) {
        const all = [0, 1, 2, 3].map((n) => ({
          ...thread(query.mailbox, `${query.mailbox}-${n}`),
          lastMessageAt: `2031-04-0${4 - n}T${query.mailbox === 'ada' ? '12' : '11'}:00:00Z`,
        }));
        return {
          threads: all.slice(0, query.limit),
          complete: query.limit >= all.length,
          matchedMessages: 4,
          examinedMessages: 4,
        };
      },
    };
    const ids: string[] = [];
    let offset = 0;
    for (let page = 0; page < 4; page++) {
      const result = await search(backend, { mailbox: '*', limit: 2, offset });
      ids.push(...(result.threads as ThreadSummary[]).map((item) => item.threadId));
      if (page < 3) {
        expect(result.nextOffset).toBe(offset + 2);
        offset = result.nextOffset as number;
      } else expect(result.coverage).toMatchObject({ complete: true });
    }
    expect(ids).toEqual(['ada-0', 'bo-0', 'ada-1', 'bo-1', 'ada-2', 'bo-2', 'ada-3', 'bo-3']);
  });
  it('reports an exact date-window scan across all configured mailboxes', async () => {
    const calls: Array<{ mailbox: string; since?: string; until?: string }> = [];
    const result = await search(
      {
        async searchThreadsWithCoverage(query) {
          calls.push(query);
          return {
            threads: [thread(query.mailbox, `thread-${query.mailbox}`)],
            matchedMessages: 1,
            examinedMessages: 1,
            complete: true,
          };
        },
      },
      { mailbox: '*', since: '2026-02-03', until: '2026-02-03', limit: 100 },
    );
    expect(calls.map(({ mailbox, since, until }) => ({ mailbox, since, until }))).toEqual([
      { mailbox: 'ada', since: '2026-02-03', until: '2026-02-03' },
      { mailbox: 'bo', since: '2026-02-03', until: '2026-02-03' },
    ]);
    expect(result.coverage).toMatchObject({ complete: true, returnedThreads: 2 });
  });

  it('marks a capped or unreachable mailbox as incomplete', async () => {
    const result = await search(
      {
        async searchThreadsWithCoverage(query) {
          if (query.mailbox === 'bo') throw new Error('fixture connection lost');
          return { threads: [thread('ada', 'thread-a')], matchedMessages: 150, examinedMessages: 100, complete: false };
        },
      },
      { mailbox: '*', since: '2026-02-03', until: '2026-02-03' },
    );
    expect(result.coverage).toMatchObject({ complete: false });
    expect(result.unreachable).toEqual(['bo: fixture connection lost']);
  });

  it('deduplicates only a proven copy of the same message', async () => {
    const result = await search(
      {
        async searchThreadsWithCoverage(query) {
          return {
            threads: [thread(query.mailbox, `thread-${query.mailbox}`, '<same@example.test>')],
            matchedMessages: 1,
            examinedMessages: 1,
            complete: true,
          };
        },
      },
      { mailbox: '*', since: '2026-02-03', until: '2026-02-03' },
    );
    expect(result.coverage).toMatchObject({ complete: true, returnedThreads: 1 });
    expect((result.threads as ThreadSummary[])[0]).toMatchObject({ alsoIn: ['bo'] });
  });
});
