import { describe, expect, it } from 'vitest';

import { extractForwardContext } from './telegram.js';

describe('extractForwardContext', () => {
  it('returns null for a message nobody forwarded', () => {
    expect(extractForwardContext({ text: 'my own words', chat: { id: 1 } })).toBeNull();
  });

  it('names the original author from forward_origin', () => {
    // Someone else's membership number, forwarded verbatim.
    expect(
      extractForwardContext({
        chat: { id: 1000000001 },
        text: 'Your Vulpine Mutual membership number is: 2222222222',
        forward_origin: {
          type: 'user',
          date: 1_932_854_400,
          sender_user: { first_name: 'Bo', last_name: 'Winters', username: 'bo_winters' },
        },
      }),
    ).toEqual({ from: 'Bo Winters', date: '2031-04-02T00:00:00.000Z' });
  });

  it('keeps a hidden sender’s name and flags the account as hidden', () => {
    expect(
      extractForwardContext({
        forward_origin: { type: 'hidden_user', date: 1_932_854_400, sender_user_name: 'Bo' },
      }),
    ).toEqual({ from: 'Bo', date: '2031-04-02T00:00:00.000Z', hidden: true });
  });

  it('names the channel for a channel forward', () => {
    expect(
      extractForwardContext({
        forward_origin: { type: 'channel', date: 1_932_854_400, chat: { title: 'Vulpine Mutual News' } },
      }),
    ).toMatchObject({ from: 'Vulpine Mutual News' });
  });

  it('still reports the forward when the origin type is unknown to us', () => {
    // Not the sender's words is the load-bearing part, not who wrote them.
    expect(extractForwardContext({ forward_origin: { type: 'something_new', date: 1_932_854_400 } })).toEqual({
      date: '2031-04-02T00:00:00.000Z',
    });
  });

  it('reads the legacy flat fields', () => {
    expect(
      extractForwardContext({
        forward_from: { first_name: 'Bo', last_name: 'Winters' },
        forward_date: 1_932_854_400,
      }),
    ).toEqual({ from: 'Bo Winters', date: '2031-04-02T00:00:00.000Z' });
  });

  it('treats a legacy sender name as a hidden account', () => {
    expect(extractForwardContext({ forward_sender_name: 'Bo' })).toEqual({ from: 'Bo', hidden: true });
  });
});
