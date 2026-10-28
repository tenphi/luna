import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchMessageObject } from 'imapflow';

const state = vi.hoisted(() => ({
  messages: [] as unknown[],
  bodies: vi.fn(),
  writes: vi.fn(),
  searches: [] as string[],
}));
vi.mock('./client.js', () => ({
  closeAllMailConnections: async () => {},
  withMailbox: async (_mailbox: unknown, work: (session: unknown) => unknown) =>
    work({
      client: {
        search: async (query: { gmraw?: string; emailId?: string }) => {
          if (query.gmraw) state.searches.push(query.gmraw);
          return state.messages
            .map((_, index) => index + 1)
            .filter((id) => !query.emailId || String(id) === query.emailId);
        },
        fetch: async function* (ids: number[]) {
          for (const id of ids) yield state.messages[id - 1];
        },
        fetchOne: async (uid: string) => state.messages[Number(uid) - 1],
        messageFlagsAdd: state.writes,
        messageFlagsRemove: state.writes,
      },
    }),
}));
vi.mock('../cache/messages.js', () => ({
  getCachedMessage: state.bodies,
  putCachedMessage: vi.fn(),
  toMailMessage: (record: unknown) => record,
}));

import { GmailImapBackend } from './backend.js';

function message(
  uid: number,
  sender: string,
  labels: string[] = [],
  date = '2026-10-06T12:00:00Z',
): FetchMessageObject {
  return {
    uid,
    emailId: String(uid),
    threadId: '100',
    internalDate: new Date(date),
    labels: new Set(labels),
    envelope: { from: [{ address: sender }], subject: 'Invented notice' },
    flags: new Set(),
    bodyStructure: undefined,
  } as unknown as FetchMessageObject;
}
const mailbox = {
  key: 'ada',
  address: 'ada@example.test',
  displayName: null,
  appPassword: 'fixture',
  ignoreLabels: ['Work'],
  ignoreSenders: ['notice@example.test'],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.searches = [];
  state.messages = [
    message(1, 'notice@example.test'),
    message(2, 'other@example.test', ['Work']),
    message(3, 'personal@example.test'),
  ];
  state.bodies.mockReturnValue({
    bodyClean: 'An invented complete personal notice.',
    bodyRaw: 'Original',
    removed: { truncatedChars: 0 },
    subject: 'Personal notice',
  });
});

describe('mail access boundaries', () => {
  it('continues past a large conversation to discover older matching threads', async () => {
    state.messages = Array.from({ length: 30 }, (_, index) => ({
      ...message(index + 1, 'personal@example.test'),
      threadId: index === 0 ? '99' : '100',
    }));
    const result = await new GmailImapBackend([mailbox]).searchThreadsWithCoverage({
      mailbox: 'ada',
      since: '2026-10-06',
      until: '2026-10-06',
      limit: 2,
    });
    expect(result.threads).toHaveLength(2);
    expect(result.complete).toBe(true);
    expect(result.matchedMessages).toBe(30);
  });

  it('keeps coverage incomplete when exclusion metadata is unavailable', async () => {
    state.messages = [{ ...message(1, 'personal@example.test'), labels: undefined }];
    const result = await new GmailImapBackend([mailbox]).searchThreadsWithCoverage({
      mailbox: 'ada',
      since: '2026-10-06',
      until: '2026-10-06',
      limit: 20,
    });
    expect(result.threads).toHaveLength(0);
    expect(result.complete).toBe(false);
    await expect(new GmailImapBackend([mailbox]).readMessage('ada:1', { maxBodyChars: 1000 })).rejects.toThrow(
      'excluded',
    );
    expect(state.bodies).not.toHaveBeenCalled();
  });
  it('filters search metadata independently of raw Gmail query syntax', async () => {
    const backend = new GmailImapBackend([mailbox]);
    const threads = await backend.searchThreads({ mailbox: 'ada', query: ') OR in:anywhere OR (', limit: 20 });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.messageCount).toBe(1);
    expect(threads[0]?.participants).toEqual(['personal@example.test']);
    expect(state.searches[0]).toContain('-label:"Work" -from:"notice@example.test"');
    expect(state.bodies).not.toHaveBeenCalled();
  });

  it.each(['1', '2'])('refuses cached message and attachment access for excluded id %s', async (id) => {
    const backend = new GmailImapBackend([mailbox]);
    await expect(backend.readMessage(`ada:${id}`, { maxBodyChars: 4000, raw: true })).rejects.toThrow('excluded');
    await expect(backend.listAttachments(`ada:${id}`)).rejects.toThrow('excluded');
    await expect(backend.fetchAttachment(`ada:${id}`, '1')).rejects.toThrow('excluded');
    expect(state.bodies).not.toHaveBeenCalled();
  });

  it('reads and mutates only permitted members of a mixed thread', async () => {
    const backend = new GmailImapBackend([mailbox]);
    expect((await backend.readThread('ada:64', 4000)).messages).toHaveLength(1);
    expect(state.bodies).toHaveBeenCalledTimes(1);
    await backend.markRead('ada:64', true);
    expect(state.writes).toHaveBeenCalledWith([3], ['\\Seen'], { uid: true });
    await backend.archive('ada:64');
    expect(state.writes).toHaveBeenCalledWith([3], ['\\Inbox'], { uid: true, useLabels: true });
  });

  it('refuses an entirely excluded thread without fetching cached bodies', async () => {
    state.messages.pop();
    const backend = new GmailImapBackend([mailbox]);
    await expect(backend.readThread('ada:64', 4000)).rejects.toThrow('excluded');
    await expect(backend.replyContext('ada:64', true)).rejects.toThrow('No readable');
    await expect(backend.markRead('ada:64', true)).rejects.toThrow('excluded');
    expect(state.bodies).not.toHaveBeenCalled();
    expect(state.writes).not.toHaveBeenCalled();
  });
});
