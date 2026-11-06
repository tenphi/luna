import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter } from './adapter.js';
import { adapterRateLimitRetryAfterSec } from './adapter-errors.js';
import { renderChangeDiff, type ChangeDetails } from '../memory/change-diff.js';

const registration = vi.hoisted(() => ({ factory: undefined as (() => ChannelAdapter | null) | undefined }));
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: (_name: string, entry: typeof registration) => {
    registration.factory = entry.factory;
  },
}));
vi.mock('../env.js', () => ({ readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }) }));

// Exercise the registered production factory, including its receipt routing.
import './telegram.js';

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(url)).pathname.split('/').at(-1)!;
    const body = JSON.parse(String(init?.body));
    calls.push({ method, body });
    return new Response(
      JSON.stringify({
        ok: true,
        result: { message_id: calls.length, date: 1, chat: { id: 42, type: 'private' }, text: 'Fixture receipt' },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetch);
  const deliver = registration.factory!()!.deliver;
  async function send(
    before: string | null,
    after: string | null,
    action: ChangeDetails['files'][number]['action'] = 'modified',
  ) {
    const messages = renderChangeDiff({
      id: 'chg_fixture',
      status: 'applied',
      files: [{ relPath: 'notes/game-list.md', action, before, after }],
    });
    for (const text of messages)
      await deliver('telegram:42', null, { kind: 'chat', content: { type: 'memory_change', text } });
    return messages;
  }
  return { calls, fetch, deliver, send };
}

describe('Telegram memory receipts', () => {
  it('delivers only readable changes from managed pages and timelines with their original lines', async () => {
    const { calls, send } = harness();
    const marker = '<!-- akno:item mem_invented v=2 -->\n';
    const suffix = ' <a id="akno-mem_invented"></a> <!-- akno:timeline-item id=mem_invented date=2031-04-05 -->';
    await send('# Notes\n', `# Notes\n${marker}- **Tentative:** Review the plan. [[notes/plan]]${suffix}\n`);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toContain('<b>Notes</b> · new line 3');
    expect(calls[0].body.text).toContain(
      '<pre><code class="language-diff">  # Notes\n+ - **Tentative:** Review the plan. [[notes/plan]]</code></pre>',
    );
    expect(calls[0].body.text).not.toContain('akno');
    await send('# Notes\n' + marker, '# Notes\n<!-- akno:item mem_invented v=3 -->\n');
    expect(calls).toHaveLength(1);
  });

  it('delivers a Markdown list append as a native diff snippet with its section and new line', async () => {
    const { calls, send } = harness();
    await send('# Backlog\n- Existing game\n', '# Backlog\n- Existing game\n- **Moon Harbor: Dawn** #Console\n');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        body: {
          chat_id: '42',
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          text:
            '🧠 Updated <code>notes/game-list.md</code>\n\n' +
            '<b>Backlog</b> · new line 3\n\n' +
            '<pre><code class="language-diff">  - Existing game\n+ - **Moon Harbor: Dawn** #Console</code></pre>\n\n' +
            'Say “undo that” to reverse this change.',
        },
      },
    ]);
  });

  it('labels removal of a whole line instead of presenting it as a replacement', async () => {
    const { calls, send } = harness();
    await send('Keep this.\nRemove this.\n', 'Keep this.\n');
    expect(calls[0].body.text).toContain('<b>Page</b> · old line 2');
    expect(calls[0].body.text).toContain('  Keep this.\n- Remove this.</code></pre>');
    expect(calls[0].body.text).not.toContain('\n+ ');
  });

  it('uses the same literal snippet format for tiny replacements', async () => {
    const { calls, send } = harness();
    await send('Prefers morning meetings.\n', 'Prefers afternoon meetings.\n');
    expect(calls[0].body.text).toContain('<b>Page</b> · line 1');
    expect(calls[0].body.text).toContain(
      '<pre><code class="language-diff">- Prefers morning meetings.\n+ Prefers afternoon meetings.</code></pre>',
    );
    expect(calls[0].body.text).not.toContain('<s>');
    expect(calls[0].body.text).not.toContain('<blockquote');
  });

  it.each(['  ', '    ', '\t'])('preserves indentation in a tiny replacement (%j)', async (indent) => {
    const { calls, send } = harness();
    await send(`${indent}- Old entry\n`, `${indent}- New entry\n`);
    expect(calls[0].body.text).toContain(`- ${indent}- Old entry\n+ ${indent}- New entry</code></pre>`);
  });

  it('numbers snippets and shows each section once above its literal change', async () => {
    const { calls, send } = harness();
    await send(
      '# Time\nOld time.\n\n# Location\nOld [place](https://invalid.example).\n',
      '# Time\nNew time.\n\n# Location\nNew <b>place</b>.\n',
    );
    expect(calls).toHaveLength(2);
    const first = String(calls[0].body.text);
    const second = String(calls[1].body.text);
    expect(first).toContain('notes/game-list.md</code> · 1/2');
    expect(first).toContain('<b>Time</b> · line 2');
    expect(second).toContain('notes/game-list.md</code> · 2/2');
    expect(second).toContain('<b>Location</b> · line 5');
    expect(second).toContain('- Old [place](https://invalid.example).\n+ New &lt;b&gt;place&lt;/b&gt;.');
    for (const text of [first, second]) {
      expect(text).not.toContain('<blockquote');
      expect(text).not.toContain('<details>');
      expect(text).not.toContain('<s>');
    }
  });

  it('preserves real backslashes, entities, source markup and URLs instead of reformatting them', async () => {
    const { calls, send } = harness();
    const source = String.raw`Use C:\notes\game-list, &copy; & <tag>, **bold**, [link](https://invalid.example), @someone.`;
    await send('Existing line.\n', `Existing line.\n${source}\n`);
    expect(calls[0].body.text).toContain(
      '+ Use C:\\notes\\game-list, &amp;copy; &amp; &lt;tag&gt;, **bold**, [link](https://invalid.example), @someone.</code></pre>',
    );
    expect(calls[0].body.text).not.toContain('<a ');
  });

  it('sends all long Unicode fragments once, as balanced messages under Telegram’s visible-text limit', async () => {
    const { calls, send } = harness();
    const count = 1800;
    const messages = await send('Old text.\n', '🌙漢字[]<>*'.repeat(count) + '\n');
    expect(calls).toHaveLength(messages.length);
    expect(calls.length).toBeGreaterThan(1);
    for (const { body } of calls) {
      const text = String(body.text);
      expect(text.match(/<pre>/g)).toHaveLength(1);
      expect(text.match(/<\/pre>/g)).toHaveLength(1);
      expect(text.match(/<code class="language-diff">/g)).toHaveLength(1);
      expect(text.match(/<\/code><\/pre>/g)).toHaveLength(1);
      // Telegram's limit applies after decoding HTML entities. Decode once
      // so literal source such as &lt; remains intact.
      const visible = text
        .replace(/<[^>]+>/g, '')
        .replace(/&(amp|lt|gt);/g, (_match, entity: string) => ({ amp: '&', lt: '<', gt: '>' })[entity]!);
      expect(visible.length).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    expect(
      calls
        .map(({ body }) => body.text)
        .join('')
        .match(/🌙/gu),
    ).toHaveLength(count);
  });

  it('shows a small new page as a native code block', async () => {
    const { calls, send } = harness();
    await send(null, '# Game list\nNew content.\n', 'created');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toContain('Created <code>notes/game-list.md</code>');
    expect(calls[0].body.text).toContain('<pre><code class="language-markdown"># Game list\nNew content.</code></pre>');
  });

  it('escapes special filename characters inside native code instead of a link', async () => {
    const { calls, deliver } = harness();
    const [text] = renderChangeDiff({
      id: 'chg_fixture',
      status: 'applied',
      files: [{ relPath: 'notes/<tag>&copy;`name.md', action: 'modified', before: 'Old\n', after: 'New\n' }],
    });
    await deliver('telegram:42', null, { kind: 'chat', content: { type: 'memory_change', text } });
    expect(calls[0].body.text).toContain('Updated <code>notes/&lt;tag&gt;&amp;copy;`name.md</code>');
    expect(calls[0].body.text).not.toContain('<a ');
    expect(calls[0].body.text).toContain('<pre><code class="language-diff">- Old\n+ New</code></pre>');
  });

  it('keeps missing newlines and blank-line removals visible in the delivered diff', async () => {
    const { calls, send } = harness();
    await send('same', 'same\n');
    expect(calls[0].body.text).toContain('- same\n\\ No newline at end of file\n+ same');
    await send('first\n\nlast\n', 'first\nnew\nlast\n');
    expect(calls[1].body.text).toContain('  first\n- \n+ new\n  last');
  });

  it('preserves code fences and source tags inside one complete native snippet', async () => {
    const { calls, send } = harness();
    await send('# Examples\n```md\n# Old\n```\n', '# Examples\n```md\n# New <tag>\n```\n');
    const text = String(calls[0].body.text);
    expect(text).toContain('<b>Examples</b> · line 3');
    expect(text).toContain(
      '<pre><code class="language-diff">  ```md\n- # Old\n+ # New &lt;tag&gt;\n  ```</code></pre>',
    );
    expect(text.match(/<pre>/g)).toHaveLength(1);
  });

  it('keeps old/new locations when an insertion shifts another changed line', async () => {
    const { calls, send } = harness();
    await send('# Notes\nKeep\nOld\n', 'Intro\n# Notes\nKeep\nNew\n');
    expect(calls.map(({ body }) => body.text).join('\n')).toContain('old line 3 → new line 4');
  });

  it('delivers legacy receipts already stored in the durable queue', async () => {
    const { calls, deliver } = harness();
    await deliver('telegram:42', null, {
      kind: 'chat',
      content: {
        type: 'memory_change',
        text: '🧠 Updated **notes/legacy**\n\n<details><summary>All changes</summary>\n\n~~Old~~ **New**\n\n</details>',
      },
    });
    expect(calls[0].body.text).toContain('<blockquote expandable><b>All changes</b>');
    expect(calls[0].body.text).toContain('<s>Old</s> <b>New</b>');
    expect(calls[0].body.text).toContain('</blockquote>');
  });

  it('rejects transport failures without falling back to an unformatted or duplicate message', async () => {
    const { fetch, send } = harness();
    fetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await expect(send('Old.\n', 'New.\n')).rejects.toThrow('Network unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns the SDK-compatible message ID and keeps silent receipts in their topic', async () => {
    const { calls, deliver } = harness();
    const id = await deliver('telegram:42', 'telegram:42:7', {
      kind: 'chat',
      content: { type: 'memory_change', text: '🧠 Updated **notes/game-list**', silent: true },
    });
    expect(id).toBe('42:1');
    expect(calls[0].body).toMatchObject({ chat_id: '42', message_thread_id: 7, disable_notification: true });
  });

  it('preserves rate-limit backoff without spending the durable queue’s retry budget', async () => {
    const { fetch, send } = harness();
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 23 },
        }),
        { status: 429 },
      ),
    );
    const error = await send('Old.\n', 'New.\n').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(adapterRateLimitRetryAfterSec(error)).toBe(23);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed topics before sending a receipt to the wrong destination', async () => {
    const { fetch, deliver } = harness();
    await expect(
      deliver('telegram:42', 'telegram:42:bad-topic', {
        kind: 'chat',
        content: { type: 'memory_change', text: 'Receipt' },
      }),
    ).rejects.toThrow('destination');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves ordinary replies on the existing Rich Markdown delivery path', async () => {
    const { calls, deliver } = harness();
    await deliver('telegram:42', null, { kind: 'chat', content: { text: '**An ordinary reply.**' } });
    expect(calls[0].method).toBe('sendRichMessage');
    expect(calls[0].body).toMatchObject({ rich_message: { markdown: '**An ordinary reply.**' } });
  });
});
