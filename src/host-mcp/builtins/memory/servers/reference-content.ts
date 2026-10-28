import { createHash } from 'node:crypto';

export interface ReferencePart {
  name: string;
  text?: string;
  unreadable?: string;
}

export interface TransactionRow {
  transaction_id?: string;
  date: string | null;
  route: string | null;
  amount: string | null;
  currency: string | null;
  source_parts: number[];
  uncertainty?: string;
}

export interface ReferenceInput {
  source_slug: string;
  title?: string;
  source?: string;
  text?: string;
  parts?: ReferencePart[];
  expected_parts?: number;
  rows?: TransactionRow[];
  replace_existing?: boolean;
  attempt?: number;
}

export interface PreparedReference {
  content: string;
  body: string;
  hash: string;
  title: string;
  source?: string;
  type: 'reference-transcription' | 'transaction-records';
  complete: boolean;
  partCount: number;
  rowCount: number;
  issues: string[];
}

const PLACEHOLDER =
  /\[(?:todo|tbd|placeholder|insert (?:text|transcription)|not transcribed|summary only|page \d+ missing)\]/i;
const SUMMARY_WRAPPER = /^(?:description|summary|overview|gist):\s/i;

function clean(value: string): string {
  return value.replaceAll('\r\n', '\n').trim();
}

function safeCell(value: string | null): string {
  return value === null ? 'Unknown' : value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function titleFromSlug(slug: string): string {
  return (slug.split('/').pop() ?? slug).replaceAll(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Build a source page without invoking semantic extraction or treating source text as instructions. */
export function prepareReference(input: ReferenceInput): PreparedReference {
  const title = clean(input.title ?? titleFromSlug(input.source_slug));
  if (!title || title.length > 200 || title.includes('\n'))
    throw new Error('Reference title must be one line of at most 200 characters.');
  if (/\.(?:md|markdown)$/i.test(input.source_slug.trim())) {
    throw new Error('Use a memory page slug without a Markdown extension.');
  }
  const parts = input.parts ?? (input.text ? [{ name: 'Reference text', text: input.text }] : []);
  if (input.parts && input.expected_parts === undefined) {
    throw new Error('Ordered source parts require expected_parts so missing pages cannot be silently omitted.');
  }
  const expected = input.expected_parts ?? parts.length;
  if (parts.length > 50) throw new Error('A source may have at most 50 parts in one save.');
  if (expected < 1 || expected !== parts.length) {
    throw new Error(`Expected ${expected} source part(s), received ${parts.length}; nothing was saved.`);
  }
  if (input.text && input.parts) throw new Error('Pass text or ordered parts, not both.');
  if (parts.reduce((size, part) => size + (part.text?.length ?? 0), 0) > 250_000) {
    throw new Error('Source text is too large for one save; split it into named source volumes.');
  }
  const names = new Set<string>();
  const issues: string[] = [];
  for (const [index, part] of parts.entries()) {
    const name = clean(part.name);
    if (!name || name.includes('\n') || names.has(name))
      throw new Error(`Part ${index + 1} needs a unique one-line name.`);
    names.add(name);
    const text = part.text === undefined ? '' : clean(part.text);
    if (part.unreadable !== undefined && !clean(part.unreadable))
      throw new Error(`Part ${index + 1} needs an unreadable reason.`);
    if (text && part.unreadable) throw new Error(`Part ${index + 1} cannot be both transcribed and unreadable.`);
    if (!text && !part.unreadable) throw new Error(`Part ${index + 1} has no transcription or unreadable reason.`);
    if (text && (PLACEHOLDER.test(text) || SUMMARY_WRAPPER.test(text)))
      throw new Error(`Part ${index + 1} looks like a placeholder or summary, not source text; nothing was saved.`);
    if (part.unreadable) issues.push(`Part ${index + 1} (${name}) is unreadable: ${clean(part.unreadable)}`);
  }

  let body: string;
  let rowCount = 0;
  if (input.rows) {
    if (input.text) throw new Error('Transaction rows need named source parts, not a text-only source.');
    const merged = new Map<string, TransactionRow>();
    const covered = new Set<number>();
    for (const [index, row] of input.rows.entries()) {
      if (!row.source_parts.length || row.source_parts.some((n) => !Number.isInteger(n) || n < 1 || n > parts.length)) {
        throw new Error(`Row ${index + 1} needs valid source part numbers.`);
      }
      if (!row.date && !row.route && !row.amount) throw new Error(`Row ${index + 1} has no transaction data.`);
      if ([row.date, row.route, row.amount, row.currency].some((value) => value !== null && !clean(value))) {
        throw new Error(`Row ${index + 1} has a blank field; use null with an uncertainty note.`);
      }
      if (
        [row.transaction_id, row.date, row.route, row.amount, row.currency, row.uncertainty].some(
          (value) => value && PLACEHOLDER.test(value),
        )
      ) {
        throw new Error(`Row ${index + 1} contains a placeholder; nothing was saved.`);
      }
      if ((!row.date || !row.route || !row.amount || !row.currency) && !clean(row.uncertainty ?? '')) {
        throw new Error(`Row ${index + 1} has missing fields without an uncertainty note.`);
      }
      for (const n of row.source_parts) covered.add(n);
      // Equal amounts and routes can be separate transactions. Merge only an
      // explicit shared transaction id with otherwise identical fields.
      const dedupeKey = row.transaction_id ? `id:${clean(row.transaction_id).toLowerCase()}` : `row:${index}`;
      const previous = merged.get(dedupeKey);
      if (
        previous &&
        [previous.date, previous.route, previous.amount, previous.currency].some(
          (value, field) => value !== [row.date, row.route, row.amount, row.currency][field],
        )
      ) {
        throw new Error(`Transaction id ${row.transaction_id} has conflicting fields; nothing was saved.`);
      }
      merged.set(
        dedupeKey,
        previous
          ? {
              ...previous,
              source_parts: [...new Set([...previous.source_parts, ...row.source_parts])].sort((a, b) => a - b),
              uncertainty:
                [previous.uncertainty, row.uncertainty]
                  .filter(Boolean)
                  .filter((v, i, all) => all.indexOf(v) === i)
                  .join('; ') || undefined,
            }
          : { ...row, source_parts: [...new Set(row.source_parts)].sort((a, b) => a - b) },
      );
    }
    for (let n = 1; n <= parts.length; n++) {
      if (!covered.has(n) && !parts[n - 1]!.unreadable)
        issues.push(`Part ${n} has no transaction row or unreadable reason.`);
    }
    rowCount = merged.size;
    if (rowCount === 0) issues.push('No transaction rows were recovered.');
    const table = [...merged.values()].map((row) => {
      if (row.uncertainty)
        issues.push(`Row from part(s) ${row.source_parts.join(', ')} has uncertainty: ${clean(row.uncertainty)}`);
      return `| ${safeCell(row.transaction_id ?? null)} | ${safeCell(row.date)} | ${safeCell(row.route)} | ${safeCell(row.amount)} | ${safeCell(row.currency)} | ${row.source_parts.join(', ')} | ${safeCell(row.uncertainty ?? null)} |`;
    });
    body = [
      '## Source readings',
      ...parts.flatMap((part, i) => [
        `### Part ${i + 1}: ${part.name}`,
        '',
        part.unreadable ? `Unreadable: ${clean(part.unreadable)}` : clean(part.text!),
        '',
      ]),
      '',
      '## Transactions',
      '| Transaction ID | Date | Route | Amount | Currency | Source parts | Uncertainty |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...table,
    ].join('\n');
  } else {
    body = parts
      .map(
        (part, i) =>
          `## Part ${i + 1}: ${part.name}\n\n${part.unreadable ? `Unreadable: ${clean(part.unreadable)}` : clean(part.text!)}`,
      )
      .join('\n\n');
  }
  if (body.length > 300_000) throw new Error('The source page is too large for one save; split it into named volumes.');

  const hash = createHash('sha256').update(body).digest('hex');
  const source = input.source ? clean(input.source) : undefined;
  const type = input.rows ? 'transaction-records' : 'reference-transcription';
  const content = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    ...(source ? [`source: ${JSON.stringify(source)}`] : []),
    'akno:',
    '  role: source',
    '  management:',
    '    remember: deny',
    '    observe: deny',
    '    dream: none',
    '---',
    '',
    `# ${title}`,
    '',
    `Coverage: ${parts.length}/${expected} source parts; ${issues.length ? 'partial' : 'complete'}.`,
    '',
    `<!-- luna-reference-start:${hash} -->`,
    body,
    `<!-- luna-reference-end:${hash} -->`,
  ].join('\n');
  return {
    content,
    body,
    hash,
    title,
    ...(source ? { source } : {}),
    type,
    complete: issues.length === 0,
    partCount: parts.length,
    rowCount,
    issues,
  };
}

/** Akno returns numbered non-empty lines; their line numbers restore blank lines. */
export function verifiedReferenceLines(
  lines: Array<{ n: number; text: string }>,
  prepared: PreparedReference,
): boolean {
  const start = lines.find((line) => line.text === `<!-- luna-reference-start:${prepared.hash} -->`);
  const end = lines.find((line) => line.text === `<!-- luna-reference-end:${prepared.hash} -->`);
  if (!start || !end || end.n <= start.n) return false;
  const reconstructed = Array<string>(end.n - start.n - 1).fill('');
  for (const line of lines) {
    if (line.n > start.n && line.n < end.n) reconstructed[line.n - start.n - 1] = line.text;
  }
  return reconstructed.join('\n') === prepared.body;
}
