import { describe, expect, it, vi } from 'vitest';
import { parseMarkdown, toPlainText } from 'chat';
import { formatMemoryPath, renderChangeDiff, type ChangeDetails } from './change-diff.js';

// The renderer gives `diffLines` a 30 ms budget and falls back to a whole-page diff past it. These
// tests check positions, not that budget, so a busy test runner must not trip the fallback.
vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return {
    ...actual,
    diffLines: (...[before, after, options]: Parameters<typeof actual.diffLines>) =>
      actual.diffLines(before, after, { ...options, timeout: undefined }),
  };
});

function change(
  before: string | null,
  after: string | null,
  action: ChangeDetails['files'][number]['action'] = 'modified',
): ChangeDetails {
  return { id: 'chg_fixture', status: 'applied', files: [{ relPath: 'notes/preferences.md', action, before, after }] };
}
function codes(message: string): string[] {
  return parseMarkdown(message)
    .children.filter((node) => node.type === 'code')
    .map((node) => node.value);
}
function plain(message: string): string {
  return toPlainText(parseMarkdown(message));
}
function changedText(messages: string[], marker: '+' | '-'): string {
  return messages
    .flatMap(codes)
    .flatMap((code) => code.split('\n'))
    .filter((line) => line.startsWith(`${marker} `))
    .map((line) => line.slice(2))
    .join('');
}

describe('memory diff snippets', () => {
  it.each([
    'notes/preferences.md',
    'notes/file`name.md',
    'notes/``example``.md',
    '`notes/example.md',
    'notes/<tag>&copy; **name** 🌙.md',
  ])('keeps the complete path in one literal inline code span (%s)', (path) => {
    const ast = parseMarkdown(formatMemoryPath(path));
    expect(ast.children).toHaveLength(1);
    const paragraph = ast.children[0];
    expect(paragraph.type).toBe('paragraph');
    if (paragraph.type !== 'paragraph') throw new Error('Expected an inline path.');
    expect(paragraph.children).toEqual([expect.objectContaining({ type: 'inlineCode', value: path })]);
  });

  it.each(['created', 'modified', 'deleted', 'moved'] as const)(
    'marks paths as inline code in %s receipts',
    (action) => {
      const input = change(
        action === 'created' ? null : 'Old\n',
        action === 'deleted' || action === 'moved' ? null : 'New\n',
        action,
      );
      input.files[0].movedTo = action === 'moved' ? 'archive/preferences.md' : undefined;
      const [message] = renderChangeDiff(input);
      const title = parseMarkdown(message).children[0];
      if (title.type !== 'paragraph') throw new Error('Expected a receipt title.');
      expect(title.children.filter((node) => node.type === 'inlineCode').map((node) => node.value)).toEqual(
        action === 'moved' ? ['notes/preferences.md', 'archive/preferences.md'] : ['notes/preferences.md'],
      );
    },
  );
  it('uses the same code format for a tiny Markdown replacement', () => {
    const [message] = renderChangeDiff(change('Prefers **morning** meetings.\n', 'Prefers **afternoon** meetings.\n'));
    expect(codes(message)).toEqual(['- Prefers **morning** meetings.\n+ Prefers **afternoon** meetings.']);
    expect(plain(message)).toContain('Updated notes/preferences.md');
    expect(message).toContain('line 1');
    expect(message).not.toContain('<details>');
    expect(message).not.toContain('~~');
  });

  it('shows a created page whole when it fits in one message, without hidden metadata', () => {
    const messages = renderChangeDiff(
      change(null, '# Preferences\n\nNew notes. <!-- akno:item mem_invented v=2 -->\n', 'created'),
    );
    expect(messages).toHaveLength(1);
    expect(plain(messages[0])).toContain('Created notes/preferences.md');
    expect(codes(messages[0])).toEqual(['# Preferences\n\nNew notes.']);
    expect(messages[0]).toContain('```markdown');
    expect(messages[0]).toContain('undo that');
  });

  it('names a created page too long to show instead of splitting it', () => {
    const body = Array.from({ length: 200 }, (_, index) => `Invented line ${index} about Blackwater Bay.`).join('\n');
    const [message, ...rest] = renderChangeDiff(change(null, body, 'created'));
    expect(rest).toEqual([]);
    expect(plain(message)).toContain('Created notes/preferences.md · 200 lines, too long to show here');
    expect(codes(message)).toEqual([]);
  });

  it('shows a mostly rewritten page whole instead of a run of snippets', () => {
    const before = Array.from({ length: 30 }, (_, index) => `## Old ${index}\nOld detail ${index}.`).join('\n');
    const after = '# Preferences\n\nPrefers afternoon meetings with Ada Marlow.\n';
    const messages = renderChangeDiff(change(before, after));
    expect(messages).toHaveLength(1);
    expect(plain(messages[0])).toContain('Rewrote notes/preferences.md');
    expect(codes(messages[0])).toEqual(['# Preferences\n\nPrefers afternoon meetings with Ada Marlow.']);
  });

  it('shows appends and deletions with an unchanged neighbor and original line locations', () => {
    const [added] = renderChangeDiff(change('Existing line.\n', 'Existing line.\nAfternoon meetings.\n'));
    expect(codes(added)).toEqual(['  Existing line.\n+ Afternoon meetings.']);
    expect(added).toContain('new line 2');
    const [removed] = renderChangeDiff(change('Existing line.\nAfternoon meetings.\n', 'Existing line.\n'));
    expect(codes(removed)).toEqual(['  Existing line.\n- Afternoon meetings.']);
    expect(removed).toContain('old line 2');
  });

  it('shows a nested breadcrumb once per snippet and keeps distant sections separate', () => {
    const messages = renderChangeDiff(
      change(
        '# Preferences\n## Meetings\nOld time.\n\n## Location\nOld place.\n',
        '# Preferences\n## Meetings\nNew time.\n\n## Location\nNew place.\n',
      ),
    );
    expect(messages).toHaveLength(2);
    expect(plain(messages[0])).toContain('Preferences → Meetings');
    expect(plain(messages[1])).toContain('Preferences → Location');
    expect(plain(messages[0]).match(/Preferences → Meetings/g)).toHaveLength(1);
    expect(codes(messages[0])[0]).toContain('- Old time.\n+ New time.');
    expect(codes(messages[1])[0]).toContain('- Old place.\n+ New place.');
    expect(messages[0]).toContain('1/2');
    expect(messages[1]).toContain('2/2');
  });

  it('tracks line shifts independently in the saved old and new snapshots', () => {
    const messages = renderChangeDiff(
      change('# Preferences\n## Meetings\nOld time.\n', 'New introduction.\n# Preferences\n## Meetings\nNew time.\n'),
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('old line 3 → new line 4');
  });

  it('supports Setext headings and keeps multiline heading text in one breadcrumb', () => {
    const [message] = renderChangeDiff(
      change(
        'Personal\npreferences\n===========\nMeetings\n--------\nOld time.\n',
        'Personal\npreferences\n===========\nMeetings\n--------\nNew time.\n',
      ),
    );
    expect(plain(message)).toContain('Personal preferences → Meetings');
    expect(message).toContain('line 6');
  });

  it('does not mistake headings inside fenced code for sections or let source fences close the snippet', () => {
    const [message] = renderChangeDiff(
      change(
        '# Guide\n## Examples\n```md\n# Not a section\nOld value.\n```\n',
        '# Guide\n## Examples\n```md\n# Not a section\nNew value.\n```\n',
      ),
    );
    expect(plain(message)).toContain('Guide → Examples');
    expect(codes(message)).toEqual(['  # Not a section\n- Old value.\n+ New value.\n  ```']);
    expect(message).toContain('line 5');
  });

  it('preserves Markdown, entities, markup, backslashes, tabs and trailing spaces literally', () => {
    const source =
      String.raw`  Use [link](https://invalid.example) <b>value</b> **bold** &copy; C:\notes\file #Console` + '\t  ';
    const [message] = renderChangeDiff(change('Existing line.\n', `Existing line.\n${source}\n`));
    expect(codes(message)).toEqual([`  Existing line.\n+ ${source}`]);
  });

  it('preserves all oversized Unicode source text across bounded, labeled fragments', () => {
    const long = '🌙漢字[]<>*'.repeat(1800);
    const messages = renderChangeDiff(change('Old text.\n', long + '\n'));
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(3200);
      expect(codes(message)).toHaveLength(1);
      expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    expect(messages.some((message) => message.includes('line fragment'))).toBe(true);
    expect(changedText(messages, '+')).toBe(long);
    expect(changedText(messages, '-')).toBe('Old text.');
  });

  it('bounds pathological code fences and keeps every source character', () => {
    const long = '`'.repeat(2500) + '~'.repeat(2500) + '<tag>&'.repeat(500);
    const messages = renderChangeDiff(change('Old text.\n', long + '\n'));
    expect(messages.every((message) => message.length <= 3200 && codes(message).length === 1)).toBe(true);
    expect(changedText(messages, '+')).toBe(long);
  });

  it('keeps whitespace-only, blank-line and missing-newline edits explicit', () => {
    expect(codes(renderChangeDiff(change('same', 'same\n'))[0])).toEqual([
      '- same\n\\ No newline at end of file\n+ same',
    ]);
    expect(codes(renderChangeDiff(change('abc\n\nxyz\n', 'abc\nnew\nxyz\n'))[0])).toEqual(['  abc\n- \n+ new\n  xyz']);
    expect(codes(renderChangeDiff(change('abc\n \nxyz\n', 'abc\n\t\nxyz\n'))[0])).toEqual(['  abc\n-  \n+ \t\n  xyz']);
  });

  it('identifies CRLF-to-LF changes without inserting invisible carriage returns into snippets', () => {
    const [message] = renderChangeDiff(change('same\r\n', 'same\n'));
    expect(codes(message)).toEqual(['- same\n\\ CRLF line ending\n+ same\n\\ LF line ending']);
    expect(message).not.toContain('\r');
  });

  it('hides owned metadata before comparing content and keeps original section and line locations', () => {
    const before = '# Notes\n## Plans\n<!-- akno:item mem_invented v=2 -->\n- Old plan.\n';
    const after =
      '# Notes\n## Plans\n<!-- akno:item mem_invented v=2 supports=' +
      'a'.repeat(6000) +
      ' -->\n<!-- akno:observation obs_invented v=1 -->\n- New plan.\n';
    const input = change(before, after);
    const [message] = renderChangeDiff(input);
    expect(renderChangeDiff(input)).toHaveLength(1);
    expect(codes(message)).toEqual(['  ## Plans\n- - Old plan.\n+ - New plan.']);
    expect(plain(message)).toContain('Notes → Plans');
    expect(message).toContain('old line 4 → new line 5');
    expect(message).not.toContain('akno:');
    expect(input.files[0]).toMatchObject({ before, after });
  });

  it('removes inline timeline anchors and comments while preserving readable Markdown and backlinks', () => {
    const suffix = (id: string) =>
      ` <a id="akno-${id}"></a> <!-- akno:timeline-item id=${id} date=2031-04-05 hash=aaaaaaaaaaaa -->`;
    const before = `# Timeline\n- **Tentative:** Old date. [[notes/plan]]${suffix('mem_oldfixture')}\n`;
    const after = `# Timeline\n- **Tentative:** New date. [[notes/plan]]${suffix('mem_newfixture')}\n`;
    const [message] = renderChangeDiff(change(before, after));
    expect(codes(message)).toEqual([
      '  # Timeline\n- - **Tentative:** Old date. [[notes/plan]]\n+ - **Tentative:** New date. [[notes/plan]]',
    ]);
    expect(message).toContain('line 2');
    expect(message).not.toContain('akno-');
    expect(message).not.toContain('akno:');
  });

  it.each([
    ['<!-- akno:item mem_invented v=1 -->\nNote.\n', '<!-- akno:item mem_invented v=2 -->\nNote.\n'],
    ['Note.\n', '<!-- akno:source-item id=source_invented -->\nNote.\n<!-- /akno:source-item -->\n'],
    ['Note. <a id="akno-mem_oldfixture"></a>\n', "Note. <a id='akno-mem_newfixture'></a>\n"],
    ['<!-- akno:timeline-memories -->', '<!-- akno:timeline-memories -->\n'],
  ])('suppresses metadata-only edits (%s)', (before, after) => {
    expect(renderChangeDiff(change(before, after))).toEqual([]);
  });

  it('hides multiline metadata and closing markers without removing the content they enclose', () => {
    const [message] = renderChangeDiff(
      change(
        '# Notes\r\n<!-- akno:extract\r\n source=invented\r\n-->\r\nOld.\r\n<!-- /akno:extract -->\r\n',
        '# Notes\r\n<!-- akno:extract -->\r\nNew.\r\n<!-- /akno:extract -->\r\n',
      ),
    );
    expect(codes(message)).toEqual(['  # Notes\n- Old.\n+ New.']);
    expect(message).toContain('old line 5 → new line 3');
  });

  it('preserves authored HTML and literal marker examples in inline, fenced and indented code', () => {
    const examples = [
      '<!-- authored note -->',
      '<a id="chapter-one"></a>',
      '<a id="akno-mem_invented">Visible link</a>',
      '`<!-- akno:item mem_invented -->`',
      '`<a id="akno-mem_invented"></a>`',
      '```md\n<!-- akno:item mem_invented -->\n<a id="akno-mem_invented"></a>\n```',
      '    <!-- akno:item mem_invented -->\n    <a id="akno-mem_invented"></a>',
      '<!-- authored example: <a id="akno-mem_invented"></a> -->',
      '\\<!-- akno:item mem_invented -->',
    ];
    for (const example of examples) {
      const messages = renderChangeDiff(change('', example + '\n'));
      expect(changedText(messages, '+')).toBe(example.replaceAll('\n', ''));
    }
  });

  it('cleans owned inline metadata from headings as well as unchanged snippet context', () => {
    const heading = '# Notes <a id="akno-mem_heading"></a> <!-- akno:heading id=mem_heading -->\n';
    const neighbor = 'Neighbor. <!-- akno:item mem_neighbor v=2 -->\n';
    const [message] = renderChangeDiff(change(heading + neighbor + 'Old.\n', heading + neighbor + 'New.\n'));
    expect(plain(message)).toContain('Notes');
    expect(codes(message)).toEqual(['  Neighbor.\n- Old.\n+ New.']);
    expect(message).not.toContain('akno');
  });

  it('does not let an unclosed literal comment mask actual metadata later in the page', () => {
    const example = '# Guide\n```md\n<!-- akno:item unfinished\n```\n';
    const marker = '<!-- akno:item mem_actualfixture v=2 -->\n';
    const [message] = renderChangeDiff(change(example + marker + 'Old.\n', example + marker + 'New.\n'));
    expect(codes(message)).toEqual(['  ```\n- Old.\n+ New.']);
    expect(message).toContain('line 6');
    expect(message).not.toContain('mem_actualfixture');
  });

  it('preserves whitespace on visible lines when an owned marker is in the middle', () => {
    const [message] = renderChangeDiff(change('Old.\n', '  First. <!-- akno:item mem_invented --> Second.\t  \n'));
    expect(codes(message)).toEqual(['- Old.\n+   First.  Second.\t  ']);
  });

  it('retains visible blank lines and a missing final newline around hidden metadata', () => {
    const [message] = renderChangeDiff(
      change('Keep.\n\n<!-- akno:item mem_invented -->\nOld.', 'Keep.\n\n<!-- akno:item mem_invented -->\nNew.'),
    );
    expect(codes(message)).toEqual(['  \n- Old.\n\\ No newline at end of file\n+ New.\n\\ No newline at end of file']);
    expect(message).toContain('line 4');
  });

  it('still acknowledges deletion of a page containing only metadata', () => {
    const [message] = renderChangeDiff(change('<!-- akno:item mem_invented v=2 -->\n', null, 'deleted'));
    expect(plain(message)).toContain('Deleted notes/preferences.md');
    expect(codes(message)).toEqual([]);
  });

  it('suppresses unchanged snapshots, internal conversation mirrors and binary attachments', () => {
    const input = change('same', 'same');
    input.files.push({ ...input.files[0], relPath: 'conversations/session/topic.md', after: 'new' });
    input.files.push({ ...input.files[0], relPath: 'notes/file.pdf', before: null, after: null });
    expect(renderChangeDiff(input)).toEqual([]);
  });

  it('keeps moved text in its original and destination sections', () => {
    const messages = renderChangeDiff(change('# First\nSame note.\n# Second\n', '# First\n# Second\nSame note.\n'));
    expect(messages).toHaveLength(2);
    expect(plain(messages[0])).toContain('First');
    expect(messages[0]).toContain('old line 2');
    expect(codes(messages[0])[0]).toContain('- Same note.');
    expect(plain(messages[1])).toContain('Second');
    expect(messages[1]).toContain('new line 3');
    expect(codes(messages[1])[0]).toContain('+ Same note.');
  });

  it('shows both outline locations when a section is renamed', () => {
    const [message] = renderChangeDiff(change('# Guide\n## Earlier\nNote.\n', '# Guide\n## Latest\nNote.\n'));
    expect(plain(message)).toContain('Before: Guide → Earlier');
    expect(plain(message)).toContain('After: Guide → Latest');
    expect(codes(message)[0]).toContain('- ## Earlier\n+ ## Latest');
  });

  it('acknowledges deletion of an empty file and file moves without fabricating content changes', () => {
    expect(plain(renderChangeDiff(change('', null, 'deleted'))[0])).toContain('Deleted notes/preferences.md');
    const input = change('Keep this note.\n', null, 'moved');
    input.files[0].movedTo = 'archive/preferences.md';
    input.files.push({
      relPath: 'archive/preferences.md',
      action: 'created',
      before: null,
      after: 'Keep this note.\n',
    });
    const messages = renderChangeDiff(input);
    // The destination is the same page, not a new one.
    expect(messages).toHaveLength(1);
    expect(messages.flatMap(codes)).toEqual([]);
    expect(plain(messages[0])).toContain('Moved notes/preferences.md to archive/preferences.md');
  });

  it('diffs a page that was edited while it moved, as Akno journals the move', () => {
    // The old path carries the old text and no destination; the new path follows as created.
    const messages = renderChangeDiff({
      id: 'chg_fixture',
      status: 'applied',
      files: [
        { relPath: 'notes/preferences.md', action: 'moved', before: '# Preferences\nOld time.\n', after: null },
        { relPath: 'archive/preferences.md', action: 'created', before: null, after: '# Preferences\nNew time.\n' },
      ],
    });
    expect(messages).toHaveLength(1);
    expect(plain(messages[0])).toContain('Moved notes/preferences.md to archive/preferences.md');
    expect(codes(messages[0])).toEqual(['  # Preferences\n- Old time.\n+ New time.']);
  });

  it('bounds long filenames and outline labels without truncating changed content', () => {
    const outline = Array.from({ length: 6 }, (_, index) => '#'.repeat(index + 1) + ' ' + '🌙'.repeat(1000)).join('\n');
    const input = change(outline + '\nOld.\n', outline + '\nNew.\n');
    input.files[0].relPath = 'notes/' + '🌙*'.repeat(1000) + '.md';
    const messages = renderChangeDiff(input);
    expect(messages.every((message) => message.length <= 3200)).toBe(true);
    expect(changedText(messages, '-')).toBe('Old.');
    expect(changedText(messages, '+')).toBe('New.');
  });

  it('keeps separate snippets when a long unchanged line would leave a gap in their context', () => {
    const context = 'unchanged '.repeat(40);
    const messages = renderChangeDiff(change(`Old one\n${context}\nOld two\n`, `New one\n${context}\nNew two\n`));
    expect(messages).toHaveLength(2);
    expect(codes(messages[0])).toEqual(['- Old one\n+ New one']);
    expect(codes(messages[1])).toEqual(['- Old two\n+ New two']);
    expect(messages[0]).toContain('line 1');
    expect(messages[1]).toContain('line 3');
  });

  it('splits a large rewrite between whole lines and retains every old and new line once', () => {
    const before = Array.from({ length: 1100 }, (_, index) => `old ${index} **value**`);
    const after = Array.from({ length: 1100 }, (_, index) => `new ${index} #Tag`);
    const messages = renderChangeDiff(change(before.join('\n') + '\n', after.join('\n') + '\n'));
    expect(messages.length).toBeGreaterThan(1);
    const rows = messages.flatMap(codes).flatMap((code) => code.split('\n'));
    expect(rows.filter((row) => row.startsWith('- ')).map((row) => row.slice(2))).toEqual(before);
    expect(rows.filter((row) => row.startsWith('+ ')).map((row) => row.slice(2))).toEqual(after);
    expect(messages.every((message) => message.length <= 3200)).toBe(true);
    expect(messages.every((message) => !message.includes('line fragment'))).toBe(true);
    for (const message of messages) {
      const code = codes(message)[0];
      for (const [marker, label] of [
        ['-', 'old'],
        ['+', 'new'],
      ]) {
        const positions = code
          .split('\n')
          .filter((row) => row.startsWith(marker))
          .map((row) => Number(/\d+/.exec(row)![0]) + 1);
        if (!positions.length) continue;
        const range =
          positions[0] === positions.at(-1) ? `line ${positions[0]}` : `lines ${positions[0]}–${positions.at(-1)}`;
        expect(message).toContain(`${label} ${range}`);
      }
    }
  });

  it('starts another snippet when context reaches the message boundary', () => {
    const firstContext = 'c'.repeat(80);
    const secondContext = 'd'.repeat(220);
    const messages = renderChangeDiff(
      change(
        `${'A'.repeat(2800)}\n${firstContext}\n${secondContext}\nold\n`,
        `new\n${firstContext}\n${secondContext}\nlatest\n`,
      ),
    );
    expect(messages).toHaveLength(2);
    expect(codes(messages[0])[0]).toContain(`+ new\n  ${firstContext}`);
    expect(codes(messages[0])[0]).not.toContain('- old');
    expect(codes(messages[1])[0]).toContain(`  ${secondContext}\n- old\n+ latest`);
    expect(messages.every((message) => message.length <= 3200)).toBe(true);
  });

  it('accounts for mixed insertions, deletions and replacements at their snapshot positions', () => {
    for (let sample = 0; sample < 100; sample++) {
      const before = ['# Guide', ...Array.from({ length: 24 }, (_, index) => `original-${index} **note** #Tag`)];
      const after = [...before];
      // Reproducible edit combinations with unique lines make the expected
      // additions/removals and their positions independent of the diff code.
      for (let index = 24; index >= 1; index--) {
        const operation = (sample * 11 + index * 7) % 9;
        if (operation === 0) after.splice(index, 1);
        if (operation === 1) after.splice(index, 1, `replacement-${sample}-${index}`);
        if (operation === 2) after.splice(index, 0, `inserted-${sample}-${index}`);
      }
      const messages = renderChangeDiff(change(before.join('\n') + '\n', after.join('\n') + '\n'));
      const rows = messages.flatMap(codes).flatMap((code) => code.split('\n'));
      expect(rows.filter((row) => row.startsWith('- ')).map((row) => row.slice(2))).toEqual(
        before.filter((line) => !after.includes(line)),
      );
      expect(rows.filter((row) => row.startsWith('+ ')).map((row) => row.slice(2))).toEqual(
        after.filter((line) => !before.includes(line)),
      );
      for (const message of messages) {
        const snippetRows = codes(message)[0].split('\n');
        const old = snippetRows.filter((row) => row.startsWith('- ')).map((row) => before.indexOf(row.slice(2)) + 1);
        const added = snippetRows.filter((row) => row.startsWith('+ ')).map((row) => after.indexOf(row.slice(2)) + 1);
        const range = (positions: number[]) =>
          positions[0] === positions.at(-1) ? `line ${positions[0]}` : `lines ${positions[0]}–${positions.at(-1)}`;
        const expected =
          old.length && added.length
            ? range(old) === range(added)
              ? range(old)
              : `old ${range(old)} → new ${range(added)}`
            : old.length
              ? `old ${range(old)}`
              : `new ${range(added)}`;
        expect(message).toContain(expected);
      }
    }
  });
});
