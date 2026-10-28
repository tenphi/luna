import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AknoError } from '@tenphi/akno-client';

const memory = vi.hoisted(() => ({
  pageContent: null as string | null,
  writes: [] as Array<{ slug: string; content: string; idempotency_key: string }>,
  mode: 'ok' as 'ok' | 'held' | 'mismatch' | 'lost-documents' | 'read-error',
  documents: [] as Array<{ id: string; rel_path: string; availability?: { missing_originals: string[] } }>,
}));

vi.mock('../../../../memory/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../memory/client.js')>('../../../../memory/client.js');
  const client = {
    call: async (name: string, input: Record<string, unknown>) => {
      if (name === 'list') return { status: 'ok', folders: [{ path: 'resources' }] };
      if (name === 'read') {
        if (!memory.pageContent) throw new AknoError('not_found', 'no page');
        if (memory.mode === 'read-error') throw new AknoError('unavailable', 'Readback unavailable');
        const titleLine = memory.pageContent.split('\n').find((line) => line.startsWith('title: '));
        const typeLine = memory.pageContent.split('\n').find((line) => line.startsWith('type: '));
        const sourceLine = memory.pageContent.split('\n').find((line) => line.startsWith('source: '));
        return {
          status: 'ok',
          page: {
            slug: input.slug,
            title: titleLine ? (JSON.parse(titleLine.slice(7)) as string) : 'Old page',
            type: typeLine?.slice(6) ?? null,
            frontmatter: sourceLine ? { source: JSON.parse(sourceLine.slice(8)) as string } : {},
            role: memory.pageContent.includes('  role: source') ? 'source' : 'knowledge',
            management: { remember: memory.pageContent.includes('    remember: deny') ? 'deny' : 'integrate' },
            lines: memory.pageContent
              .split('\n')
              .map((text, index) => ({ n: index + 1, text }))
              .filter((line) => line.text),
            documents: memory.documents,
          },
        };
      }
      if (name === 'write') {
        memory.writes.push(input as { slug: string; content: string; idempotency_key: string });
        if (memory.mode === 'held') return { status: 'ok', outcome: 'requires_folder', wrote: [] };
        memory.pageContent = memory.mode === 'mismatch' ? 'wrong readback' : String(input.content);
        if (memory.mode === 'lost-documents') memory.documents = [];
        return {
          status: 'ok',
          outcome: 'ok',
          change_id: 'chg_reference',
          wrote: [{ slug: input.slug, action: 'created' }],
        };
      }
      throw new Error(`Unexpected memory operation: ${name}`);
    },
    retain: async () => {
      throw new Error('A reference save must not run semantic retention');
    },
  };
  return {
    ...actual,
    withReceiptMemory: async (_key: string, work: (client: unknown) => Promise<unknown>) => work(client as never),
  };
});

vi.mock('../../../../memory/digest.js', () => ({ noteAgentMemoryPages: vi.fn() }));
vi.mock('../../../../memory/change-notifications.js', () => ({ queueCallerMemoryChanges: vi.fn() }));

import { runAsCaller } from '../../../caller-context.js';
import { createMemoryMcpServer } from './memory.js';
import { queueCallerMemoryChanges } from '../../../../memory/change-notifications.js';

interface RegisteredTool {
  handler: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function retainTool(): RegisteredTool {
  const server = createMemoryMcpServer();
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools.retain!;
}

function parsed(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function save(args: Record<string, unknown>) {
  return runAsCaller({ agentGroupId: 'grp-1', sessionId: 'sess-1' }, () => retainTool().handler(args));
}

describe('saving complete references', () => {
  it('queues the committed receipt even when preservation readback is unavailable', async () => {
    memory.mode = 'read-error';
    const result = await save({ source_slug: 'resources/guide', text: 'Invented source text.' });
    expect(result.isError).toBe(true);
    expect(queueCallerMemoryChanges).toHaveBeenCalledWith(expect.objectContaining({ change_id: 'chg_reference' }));
  });

  beforeEach(() => {
    memory.pageContent = null;
    memory.writes = [];
    memory.mode = 'ok';
    memory.documents = [];
  });

  it('writes and reads back ten ordered pages as one source without semantic extraction', async () => {
    const parts = Array.from({ length: 10 }, (_, i) => ({
      name: `scan-${i + 1}.png`,
      text: `Page ${i + 1} of the invented guide. Unique clause ${i + 1}.`,
    }));
    const args = { source_slug: 'resources/invented-guide', title: 'Invented guide', parts, expected_parts: 10 };
    const result = parsed(await save(args));
    expect(result).toMatchObject({ outcome: 'preserved', preserved: true, complete: true, parts: 10, rows: 0 });
    expect(memory.writes).toHaveLength(1);
    expect(memory.writes[0]!.content).toContain('akno:\n  role: source\n  management:\n    remember: deny');
    for (const part of parts) expect(memory.writes[0]!.content).toContain(part.text);
    expect(memory.writes[0]!.content).toContain('## Part 10: scan-10.png');
    expect(memory.writes[0]!.idempotency_key).toMatch(/^luna:reference:/);
    expect(parsed(await save(args))).toMatchObject({ outcome: 'replayed', complete: true });
    expect(memory.writes).toHaveLength(1);
  });

  it('deduplicates seven screenshot rows and reports uncertain data as partial', async () => {
    const parts = Array.from({ length: 7 }, (_, i) => ({
      name: `transaction-${i + 1}.png`,
      text: `Transaction screenshot ${i + 1}`,
    }));
    const rows = Array.from({ length: 7 }, (_, i) => ({
      transaction_id: `txn-${i + 1}`,
      date: i === 6 ? null : `2031-04-${String(i + 1).padStart(2, '0')}`,
      route: `Station ${i + 1} → Station ${i + 2}`,
      amount: i === 6 ? null : `${i + 1}.50`,
      currency: i === 6 ? null : 'EUR',
      source_parts: [i + 1],
      ...(i === 6 ? { uncertainty: 'Date and amount cropped out' } : {}),
    }));
    rows[5] = { ...rows[0]!, source_parts: [6] };
    const result = parsed(await save({ source_slug: 'resources/transactions', parts, expected_parts: 7, rows }));
    expect(result).toMatchObject({ outcome: 'partial', preserved: true, complete: false, parts: 7, rows: 6 });
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('cropped out')]));
    expect(memory.writes[0]!.content).toContain('| 1, 6 |');
    expect(memory.writes[0]!.content).toContain('| Unknown |');
    expect(memory.writes[0]!.content).toContain('### Part 7: transaction-7.png');
    expect(memory.writes[0]!.content).toContain('Transaction screenshot 7');
  });

  it('refuses missing parts and placeholders before writing', async () => {
    const omittedCount = await save({ source_slug: 'resources/guide', parts: [{ name: 'one', text: 'Page one' }] });
    expect(omittedCount.isError).toBe(true);
    const incomplete = await save({
      source_slug: 'resources/guide',
      parts: [{ name: 'one', text: 'Page one' }],
      expected_parts: 2,
    });
    expect(incomplete.isError).toBe(true);
    const placeholder = await save({ source_slug: 'resources/guide', text: 'Part 1 [not transcribed]' });
    expect(placeholder.isError).toBe(true);
    const summary = await save({ source_slug: 'resources/guide', text: 'Summary: ten pages about routes.' });
    expect(summary.isError).toBe(true);
    expect(memory.writes).toHaveLength(0);
  });

  it('does not claim preservation when a write is held or readback differs', async () => {
    memory.mode = 'held';
    expect(parsed(await save({ source_slug: 'resources/guide', text: 'Actual source text.' }))).toMatchObject({
      outcome: 'requires_folder',
      preserved: false,
      complete: false,
    });
    memory.mode = 'mismatch';
    expect(parsed(await save({ source_slug: 'resources/guide', text: 'Actual source text.' }))).toMatchObject({
      outcome: 'held',
      preserved: false,
      complete: false,
      change_id: 'chg_reference',
    });
  });

  it('requires an explicit replacement and reports old documents after verified replacement', async () => {
    memory.pageContent =
      '---\ntitle: "Old page"\ntype: reference-transcription\nakno:\n  role: source\n  management:\n    remember: deny\n---\n\nOld summary-only stub';
    memory.documents = [{ id: 'original-image-1', rel_path: 'resources/guide/source-image.png' }];
    const args = { source_slug: 'resources/guide', text: 'The complete replacement.' };
    expect(parsed(await save(args))).toMatchObject({ outcome: 'held', reason: 'destination_exists' });
    expect(memory.writes).toHaveLength(0);
    expect(parsed(await save({ ...args, replace_existing: true }))).toMatchObject({
      outcome: 'preserved',
      complete: true,
      previous_documents: ['original-image-1'],
      original_links_reconciled: true,
    });
    expect(memory.writes[0]!.content).not.toContain('Old summary-only stub');
    expect(memory.writes[0]!.content).toContain('## Original files\n\n![[source-image.png]]');
    expect(parsed(await save({ ...args, replace_existing: true }))).toMatchObject({ outcome: 'replayed' });
    expect(memory.writes).toHaveLength(1);
  });

  it('does not claim a verified replacement if original document links disappear', async () => {
    memory.pageContent =
      '---\ntitle: "Old page"\nakno:\n  role: source\n  management:\n    remember: deny\n---\n\nOld summary';
    memory.documents = [{ id: 'image-1', rel_path: 'resources/guide/image-1.png' }];
    memory.mode = 'lost-documents';
    expect(
      parsed(await save({ source_slug: 'resources/guide', text: 'Full text.', replace_existing: true })),
    ).toMatchObject({ outcome: 'held', preserved: false, original_links_reconciled: false });
  });

  it('does not replace a knowledge page or claim changed metadata was replayed', async () => {
    memory.pageContent = '---\ntitle: "Knowledge"\nakno:\n  role: knowledge\n---\n\nA current fact.';
    expect(
      parsed(await save({ source_slug: 'resources/guide', text: 'Reference', replace_existing: true })),
    ).toMatchObject({
      outcome: 'held',
      reason: 'not_source_page',
      preserved: false,
    });
    expect(memory.writes).toHaveLength(0);

    memory.pageContent = null;
    const args = {
      source_slug: 'resources/new-guide',
      title: 'First title',
      text: 'A full source.',
      source: 'Sender A',
    };
    expect(parsed(await save(args))).toMatchObject({ outcome: 'preserved' });
    expect(parsed(await save({ ...args, title: 'Second title', source: 'Sender B' }))).toMatchObject({
      outcome: 'held',
      reason: 'destination_exists',
    });
    expect(
      parsed(await save({ ...args, title: 'Second title', source: 'Sender B', replace_existing: true })),
    ).toMatchObject({
      outcome: 'preserved',
      complete: true,
    });
    expect(memory.writes).toHaveLength(2);
    expect(memory.writes[0]!.idempotency_key).not.toBe(memory.writes[1]!.idempotency_key);
  });
});
