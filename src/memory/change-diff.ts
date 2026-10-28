import { diffLines } from 'diff';
import { parseMarkdown, toPlainText } from 'chat';
import * as z from 'zod';

export const changeDetailsSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  status: z.enum(['applied', 'undone']),
  files: z.array(
    z.object({
      relPath: z.string(),
      action: z.enum(['created', 'modified', 'deleted', 'moved']),
      before: z.string().nullable(),
      after: z.string().nullable(),
      movedTo: z.string().optional(),
    }),
  ),
});
export type ChangeDetails = z.infer<typeof changeDetailsSchema>;

// Complete messages stay below the bridge's 3500-character split, including
// their fences. Reserve room for numbering after all parts are known.
const MAX_MESSAGE = 3200;
const CONTENT_LIMIT = MAX_MESSAGE - 64;
const CONTEXT_LIMIT = 240;
const UNDO_NOTICE = '\n\nSay “undo that” to reverse this change.';

export function escapeDiffText(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+.!|~\-:/@&]/g, '\\$&');
}

function displayName(text: string, limit = 160): string {
  const chars = Array.from(text);
  return escapeDiffText(chars.slice(0, limit).join('') + (chars.length > limit ? '…' : ''));
}

/** Inline code stops chat clients from treating a .md filename as a URL. */
export function formatMemoryPath(path: string): string {
  const chars = Array.from(path.replace(/[\r\n]/g, ' '));
  const label = chars.slice(0, 160).join('') + (chars.length > 160 ? '…' : '');
  let length = 1;
  for (const run of label.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const delimiter = '`'.repeat(length);
  // Padding protects paths starting/ending with backticks; Markdown removes
  // exactly these added spaces while retaining the literal filename.
  return `${delimiter} ${label} ${delimiter}`;
}

interface SourceLine {
  text: string;
  ending: '' | '\n' | '\r\n';
}

function sourceLines(text: string): SourceLine[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line, index) => {
    const terminated = index < lines.length - 1 || text.endsWith('\n');
    return terminated && line.endsWith('\r')
      ? { text: line.slice(0, -1), ending: '\r\n' }
      : { text: line, ending: terminated ? '\n' : '' };
  });
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface DisplayLine extends SourceLine {
  sourceLine: number;
}

/** Hide Akno-owned HTML in the display only, retaining the saved line coordinates. */
function displayLines(text: string): DisplayLine[] {
  const html: { start: number; end: number }[] = [];
  function collect(node: MarkdownNode): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'html' && start !== undefined && end !== undefined) {
      const previous = html.at(-1);
      // Inline anchors have separate opening/closing HTML nodes. Join adjacent
      // HTML separated only by whitespace, without crossing literal examples.
      if (previous && /^\s*$/.test(text.slice(previous.end, start))) previous.end = end;
      else html.push({ start, end });
    }
    for (const child of node.children ?? []) collect(child);
  }
  collect(parseMarkdown(text));

  const removed: { start: number; end: number }[] = [];
  // Match whole comments first so an authored comment containing an example
  // anchor is left intact. Scan only parsed HTML so unfinished literal comments
  // cannot swallow a real metadata marker farther down the page.
  const pieces: string[] = [];
  let sourceOffset = 0;
  for (const range of html) {
    pieces.push(text.slice(sourceOffset, range.start));
    pieces.push(
      text
        .slice(range.start, range.end)
        .replace(
          /<!--[\s\S]*?-->|<a\s+id=(?:"akno-[A-Za-z0-9_-]+"|'akno-[A-Za-z0-9_-]+')\s*>\s*<\/a\s*>/gi,
          (match, offset: number) => {
            if (match.startsWith('<!--') && !/^<!--\s*\/?akno:/i.test(match)) return match;
            removed.push({ start: range.start + offset, end: range.start + offset + match.length });
            // Preserve newlines until the original source coordinates are assigned.
            return match.replace(/[^\r\n]/g, '');
          },
        ),
    );
    sourceOffset = range.end;
  }
  pieces.push(text.slice(sourceOffset));
  const visible = pieces.join('');
  const original = sourceLines(text);
  let offset = 0;
  let removedIndex = 0;
  return sourceLines(visible).flatMap((line, index) => {
    const start = offset;
    offset += original[index].text.length + original[index].ending.length;
    while (removedIndex < removed.length && removed[removedIndex].end <= start) removedIndex++;
    let lastRemoved: (typeof removed)[number] | undefined;
    for (let cursor = removedIndex; cursor < removed.length && removed[cursor].start < offset; cursor++)
      lastRemoved = removed[cursor];
    if (lastRemoved && !line.text.trim()) return [];
    const tailRemoved = lastRemoved && lastRemoved.end >= start + original[index].text.trimEnd().length;
    return [{ ...line, text: tailRemoved ? line.text.replace(/[ \t]+$/, '') : line.text, sourceLine: index + 1 }];
  });
}

/** Top-level Markdown headings form the outline; fenced examples do not. */
function sections(text: string): string[][] {
  const result = sourceLines(text).map(() => [] as string[]);
  const headings = parseMarkdown(text).children.filter((node) => node.type === 'heading');
  let start = 0;
  const stack: { depth: number; title: string }[] = [];
  for (const heading of headings) {
    const line = (heading.position?.start.line ?? 1) - 1;
    for (; start < line; start++) result[start] = stack.map((item) => item.title);
    while (stack.length && stack[stack.length - 1].depth >= heading.depth) stack.pop();
    stack.push({
      depth: heading.depth,
      title: toPlainText({ type: 'root', children: [heading] })
        .replace(/\s+/g, ' ')
        .trim(),
    });
  }
  for (; start < result.length; start++) result[start] = stack.map((item) => item.title);
  return result;
}

interface DiffRow extends SourceLine {
  marker: ' ' | '+' | '-';
  oldLine?: number;
  newLine?: number;
  section: string[];
  fragment?: { index: number; total: number };
}

function diffRows(before: string, after: string): DiffRow[] {
  const oldLines = displayLines(before);
  const newLines = displayLines(after);
  const oldText = oldLines.map((line) => line.text + line.ending).join('');
  const newText = newLines.map((line) => line.text + line.ending).join('');
  const oldSections = sections(oldText);
  const newSections = sections(newText);
  const parts = diffLines(oldText, newText, { timeout: 30, maxEditLength: 2000 }) ?? [
    { removed: true, added: false, value: oldText },
    { removed: false, added: true, value: newText },
  ];
  let oldLine = 1;
  let newLine = 1;
  return parts.flatMap((part) =>
    sourceLines(part.value).map((line) => {
      const row: DiffRow = {
        ...line,
        marker: part.removed ? '-' : part.added ? '+' : ' ',
        section: (part.removed ? oldSections[oldLine - 1] : newSections[newLine - 1]) ?? [],
      };
      if (!part.added) row.oldLine = oldLines[oldLine++ - 1].sourceLine;
      if (!part.removed) row.newLine = newLines[newLine++ - 1].sourceLine;
      return row;
    }),
  );
}

function commonSection(paths: string[][]): string[] {
  if (!paths.length) return [];
  return paths[0].slice(
    0,
    paths.reduce((length, path) => {
      let index = 0;
      while (index < length && path[index] === paths[0][index]) index++;
      return index;
    }, paths[0].length),
  );
}

function sectionLabel(rows: DiffRow[]): string {
  const oldPaths = rows.filter((row) => row.marker === '-').map((row) => row.section);
  const newPaths = rows.filter((row) => row.marker === '+').map((row) => row.section);
  const oldPath = oldPaths.length ? commonSection(oldPaths).join(' → ') || 'Page' : '';
  const newPath = newPaths.length ? commonSection(newPaths).join(' → ') || 'Page' : '';
  return oldPath && newPath && oldPath !== newPath
    ? `Before: ${oldPath}\nAfter: ${newPath}`
    : oldPath || newPath || 'Page';
}

/** Group nearby edits within the same outline location, with one context line. */
function hunks(rows: DiffRow[]): { rows: DiffRow[]; section: string }[] {
  const ranges: { start: number; end: number; section: string }[] = [];
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].marker === ' ') continue;
    const start = index;
    while (index + 1 < rows.length && rows[index + 1].marker !== ' ') index++;
    const section = sectionLabel(rows.slice(start, index + 1));
    const previous = ranges.at(-1);
    const completeContext =
      previous && rows.slice(previous.end + 1, start).every((row) => row.text.length <= CONTEXT_LIMIT);
    if (previous && start - previous.end <= 3 && previous.section === section && completeContext) previous.end = index;
    else ranges.push({ start, end: index, section });
  }
  return ranges.map(({ start, end, section }) => ({
    section,
    rows: rows
      .slice(Math.max(0, start - 1), end + 2)
      .filter((row) => row.marker !== ' ' || row.text.length <= CONTEXT_LIMIT),
  }));
}

function lineRange(lines: number[]): string {
  const start = lines[0];
  const end = lines[lines.length - 1];
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

function location(rows: DiffRow[]): string {
  const old = rows.filter((row) => row.marker === '-' && row.oldLine !== undefined).map((row) => row.oldLine!);
  const added = rows.filter((row) => row.marker === '+' && row.newLine !== undefined).map((row) => row.newLine!);
  const oldRange = old.length ? lineRange(old) : '';
  const newRange = added.length ? lineRange(added) : '';
  if (oldRange && newRange) return oldRange === newRange ? oldRange : `old ${oldRange} → new ${newRange}`;
  return oldRange ? `old ${oldRange}` : `new ${newRange}`;
}

/** A source code fence may occur in the context, so choose a safe outer fence. */
function codeBlock(text: string): string {
  const runLength = (char: string) => {
    let longest = 2;
    for (const run of text.matchAll(new RegExp(`${char}+`, 'g'))) longest = Math.max(longest, run[0].length);
    return longest;
  };
  const ticks = runLength('`');
  const tildes = runLength('~');
  const fence = (ticks <= tildes ? '`' : '~').repeat(Math.min(ticks, tildes) + 1);
  return `${fence}diff\n${text}\n${fence}`;
}

function snippet(rows: DiffRow[], showEndings: boolean): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${row.marker} ${row.text}`);
    if (row.fragment && row.fragment.index !== row.fragment.total) continue;
    if (!row.ending) lines.push('\\ No newline at end of file');
    else if (showEndings && row.marker !== ' ') lines.push(`\\ ${row.ending === '\r\n' ? 'CRLF' : 'LF'} line ending`);
  }
  return codeBlock(lines.join('\n'));
}

function messageBody(title: string, section: string, rows: DiffRow[], showEndings: boolean): string {
  const heading = section
    .split('\n')
    .map((part) => `**${displayName(part, 120)}**`)
    .join('\n');
  const fragment = rows[0]?.fragment;
  const continuation = fragment ? ` · line fragment ${fragment.index}/${fragment.total}` : '';
  return `${title}\n\n${heading} · ${location(rows)}${continuation}\n\n${snippet(rows, showEndings)}${UNDO_NOTICE}`;
}

/** Only an oversized changed line is fragmented; its original location is kept. */
function splitRow(row: DiffRow, fits: (rows: DiffRow[]) => boolean): DiffRow[] {
  if (fits([row])) return [row];
  const chars = Array.from(row.text);
  const result: DiffRow[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let low = 1;
    let high = Math.min(chars.length - offset, MAX_MESSAGE);
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      const candidate = {
        ...row,
        text: chars.slice(offset, offset + length).join(''),
        fragment: { index: 999999999, total: 999999999 },
      };
      if (fits([candidate])) low = length;
      else high = length - 1;
    }
    result.push({ ...row, text: chars.slice(offset, offset + low).join('') });
    offset += low;
  }
  return result.map((part, index) => ({ ...part, fragment: { index: index + 1, total: result.length } }));
}

export function renderChangeDiff(change: ChangeDetails): string[] {
  const messages: string[] = [];
  for (const file of change.files) {
    if (!file.relPath.endsWith('.md') || file.relPath.startsWith('conversations/')) continue;
    const name = formatMemoryPath(file.relPath);
    if (file.action === 'created') {
      messages.push(`🧠 Created ${name}${UNDO_NOTICE}`);
      continue;
    }
    if (file.action === 'moved') {
      messages.push(`🧠 Moved ${name}${file.movedTo ? ` to ${formatMemoryPath(file.movedTo)}` : ''}${UNDO_NOTICE}`);
      continue;
    }
    if (file.before === file.after) continue;
    const before = file.before ?? '';
    const after = file.after ?? '';
    const title = `🧠 ${file.action === 'deleted' ? 'Deleted' : 'Updated'} ${name}`;
    const rows = diffRows(before, after);
    const changed = rows.filter((row) => row.marker !== ' ');
    const showEndings = changed.some((row) => row.ending === '\r\n') && changed.some((row) => row.ending === '\n');
    const bodies: string[] = [];
    for (const hunk of hunks(rows)) {
      const fits = (rows: DiffRow[]) => messageBody(title, hunk.section, rows, showEndings).length <= CONTENT_LIMIT;
      let pending: DiffRow[] = [];
      const flush = () => {
        if (pending.some((row) => row.marker !== ' '))
          bodies.push(messageBody(title, hunk.section, pending, showEndings));
        pending = [];
      };
      for (const row of hunk.rows) {
        if (row.marker === ' ') {
          // Dropping a context line from the middle would make separated
          // changes appear adjacent. Start a new snippet at that boundary.
          if (!fits([...pending, row])) flush();
          if (fits([row])) pending.push(row);
          continue;
        }
        for (const part of splitRow(row, fits)) {
          if (part.fragment) {
            flush();
            bodies.push(messageBody(title, hunk.section, [part], showEndings));
          } else {
            if (!fits([...pending, part])) flush();
            pending.push(part);
          }
        }
      }
      flush();
    }
    if (!bodies.length && file.action === 'deleted') bodies.push(`${title}${UNDO_NOTICE}`);
    messages.push(
      ...bodies.map((body, index) =>
        bodies.length > 1 ? body.replace(title, `${title} · ${index + 1}/${bodies.length}`) : body,
      ),
    );
  }
  return messages;
}
