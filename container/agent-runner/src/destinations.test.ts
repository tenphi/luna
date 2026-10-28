import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { installTestSessionClient, resetTestSessionClient } from './session/test-support.js';
import type { InMemorySessionClient } from './session/client.js';
import { buildSystemPromptAddendum, resolveReplyDestination } from './destinations.js';

let client: InMemorySessionClient;

beforeEach(() => {
  client = installTestSessionClient();
});

afterEach(() => {
  resetTestSessionClient();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  client.destinations.push({
    name,
    display_name: displayName,
    type: 'channel',
    channel_type: channelType,
    platform_id: platformId,
    agent_group_id: null,
  });
}

describe('resolveReplyDestination', () => {
  it('resolves inbound routing to a named destination', async () => {
    seedDestination('telegram-test', 'Telegram', 'telegram', 'chan-1');
    const dest = await resolveReplyDestination({ channelType: 'telegram', platformId: 'chan-1' });
    expect(dest?.name).toBe('telegram-test');
  });

  it('falls back to the only destination when routing is unknown', async () => {
    seedDestination('solo', 'Solo', 'telegram', 'tg-1');
    const dest = await resolveReplyDestination({ channelType: null, platformId: null });
    expect(dest?.name).toBe('solo');
  });

  it('returns undefined when multiple destinations and no routing match', async () => {
    seedDestination('a', 'A', 'telegram', '1');
    seedDestination('b', 'B', 'cli', '2');
    expect(await resolveReplyDestination({ channelType: null, platformId: null })).toBeUndefined();
  });
});

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', async () => {
    seedDestination('casa', 'Casa', 'telegram', 'group-1');
    seedDestination('telegram-mg-17780', 'telegram-mg-17780', 'telegram', 'phone-2');

    const prompt = await buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('incoming message’s `from` destination');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`telegram-mg-17780`');
  });

  it('names the destination without restating static send rules', async () => {
    seedDestination('casa', 'Casa', 'cli', 'local');

    const prompt = await buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('`casa`');
    // Send rules live in mcp-tools/core.instructions.md — don't duplicate them here.
    expect(prompt).not.toContain('Plain text is fine');
    expect(prompt).not.toContain('<message to="name">');
    expect(prompt).not.toContain('send_message');
    expect(prompt).not.toContain('GitHub-flavored Markdown');
  });

  it('includes a one-line Telegram GFM rule when a telegram destination exists', async () => {
    seedDestination('tg', 'Telegram', 'telegram', 'tg-1');

    const prompt = await buildSystemPromptAddendum('Luna');

    expect(prompt).toContain('GitHub-flavored Markdown');
    // Details belong to the telegram-formatting skill fragment, not the addendum.
    expect(prompt).not.toContain('### Telegram formatting');
    expect(prompt).not.toContain('/telegram-formatting');
  });

  it('omits Telegram GFM guidance when no telegram destination exists', async () => {
    seedDestination('cli-test', 'CLI', 'cli', 'chan-1');

    const prompt = await buildSystemPromptAddendum('Luna');

    expect(prompt).not.toContain('GitHub-flavored Markdown');
  });

  it('handles the no-destination case without crashing', async () => {
    const prompt = await buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('No destinations are connected');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing guidance for a single destination', async () => {
    seedDestination('casa', 'Casa', 'telegram', 'group-1');

    const prompt = await buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('incoming message’s `from` destination');
    expect(prompt).toContain('`casa`');
  });
});
