import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../config/paths.js', () => ({
  configDir: () => '/tmp/luna-test-memory-tools/config',
  defaultConfigPath: () => '/tmp/luna-test-memory-tools/config/default.jsonc',
  localConfigPath: () => '/tmp/luna-test-memory-tools/config/local.jsonc',
}));

let dataDir = '';
let agentDir = '';
vi.mock('../../../../install-paths.js', () => ({ getAgentDir: () => agentDir }));
vi.mock('../../../../session-manager.js', () => ({
  sessionDir: (groupId: string, sessionId: string) => path.join(dataDir, 'sessions', groupId, sessionId),
}));

// No service in a test run, so every call takes the unreachable path — which is the half worth
// pinning anyway. The surface itself needs no service to inspect.
import { contextRequest, createMemoryMcpServer, factListText } from './memory.js';
import { runAsCaller } from '../../../caller-context.js';

interface RegisteredTool {
  description?: string;
  inputSchema?: unknown;
  handler: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function tools(): Record<string, RegisteredTool> {
  const server = createMemoryMcpServer();
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

/**
 * The agent's whole memory surface. Two things are asserted here and nothing else:
 * *which* tools exist, and that an unreachable service is reported as an outage.
 *
 * The second one is the load-bearing case. An agent told "nothing found" will confidently answer
 * that the user never mentioned something; the difference between "memory is empty" and "memory is
 * down" is the difference between a correct answer and a confident lie about the user's own history.
 */
describe('the memory tool surface', () => {
  it('exposes the memory operations and scoped edit reader', () => {
    expect(Object.keys(tools()).sort()).toEqual(
      [
        'context',
        'edit_diff',
        // Declaring a folder is a precondition for writing into a new one; a new top-level
        // namespace requests the owner's approval at the host boundary.
        'folder',
        'forget',
        'ingest',
        'list',
        'move',
        'read',
        'recall',
        'remember',
        'retain',
        'timeline',
        'undo',
        'write',
        // Not a general op: `approve` stays off the surface. This resolves placement proposals
        // on the agent's judgement while factual conflicts still require the owner's answer.
        'answer_proposal',
      ].sort(),
    );
  });

  it('never names the product to the model', () => {
    // A model reasons about a faculty it has, not a product it was integrated with. "Akno" in a
    // tool description invites it to hedge about its own recall.
    for (const [name, tool] of Object.entries(tools())) {
      expect(tool.description, name).toBeTruthy();
      expect(tool.description!.toLowerCase(), name).not.toContain('akno');
    }
  });

  it('tells recall’s caller what the status field means', () => {
    // Without this an agent cannot tell a genuinely empty memory from a degraded search.
    const description = tools().recall.description!;
    expect(description).toContain('empty');
    expect(description).toContain('degraded');
    expect(description).toMatch(/absence proves nothing/i);
  });

  it('teaches callers how protocol-v3 observation qualifications differ from facts', () => {
    expect(tools().recall.description).toMatch(/observation.*derived pattern/i);
    expect(tools().recall.description).toMatch(/status is `eligible`/i);
    expect(tools().read.description).toMatch(/ineligible.*must not be used as evidence/i);
  });

  it('preserves protocol-v4 retained-memory intent instead of flattening it into facts', () => {
    const recall = tools().recall;
    expect(recall.description).toMatch(/memory.*source-native retained memory/i);
    expect(recall.description).toMatch(/`unavailable` must not be used as evidence/i);
    expect(recall.description).toMatch(/answer_eligible: false.*selected `memory_view`/i);
    expect(recall.description).toMatch(/source, commitment and disposition/i);
    expect(tools().read.description).toMatch(/memory\.status.*unavailable.*not evidence/i);
  });

  it('exposes only Akno protocol-v4 recall modes and every retained-memory view', () => {
    const recall = tools().recall.inputSchema as {
      shape: {
        mode: { safeParse: (value: unknown) => { success: boolean } };
        memory_view: { safeParse: (value: unknown) => { success: boolean } };
      };
    };
    const context = tools().context.inputSchema as {
      shape: {
        mode: { safeParse: (value: unknown) => { success: boolean } };
        memory_view: { safeParse: (value: unknown) => { success: boolean } };
      };
    };

    for (const mode of ['lookup', 'question', 'explore']) {
      expect(recall.shape.mode.safeParse(mode).success, mode).toBe(true);
      expect(context.shape.mode.safeParse(mode).success, mode).toBe(true);
    }
    for (const removed of ['auto', 'topic']) expect(recall.shape.mode.safeParse(removed).success, removed).toBe(false);
    for (const view of ['factual', 'history', 'planning', 'reports', 'questions', 'discussion', 'all']) {
      expect(recall.shape.memory_view.safeParse(view).success, view).toBe(true);
      expect(context.shape.memory_view.safeParse(view).success, view).toBe(true);
    }
  });

  it('offers the compact fact list as a recall format', () => {
    const recall = tools().recall;
    const format = (
      recall.inputSchema as { shape: { format: { safeParse: (value: unknown) => { success: boolean } } } }
    ).shape.format;
    for (const value of ['cards', 'facts']) expect(format.safeParse(value).success, value).toBe(true);
    expect(format.safeParse('summary').success).toBe(false);
    expect(recall.description).toMatch(/format: "facts".*slug:line/i);
  });

  it('sends the fact list as text with its status, not inside the JSON envelope', () => {
    const text = factListText({
      status: 'degraded',
      degraded: ['no_vector_index'],
      memory_view: 'factual',
      coverage: { warranty: true, price: false },
      text: 'Facts (claim · source line; read slug:line for exact wording):\nzephyr-qx-100 — Zephyr QX-100\n  L9 The Zephyr QX-100 warranty expires on 2031-11-11.',
    });
    expect(text).toBe(
      [
        'status: degraded (no_vector_index) · memory_view: factual',
        'coverage: warranty yes; price no',
        '',
        'Facts (claim · source line; read slug:line for exact wording):',
        'zephyr-qx-100 — Zephyr QX-100',
        '  L9 The Zephyr QX-100 warranty expires on 2031-11-11.',
      ].join('\n'),
    );
    // An older service ignores the format and answers with cards, which keep their usual JSON.
    expect(factListText({ status: 'ok' })).toBeNull();
  });

  it('keeps a model fallback warning in the compact fact list, and tells the agent to pass it on', () => {
    const text = factListText({
      status: 'ok',
      warnings: [
        {
          type: 'model_fallback',
          role: 'expansion',
          provider: 'subscription',
          fallback_provider: 'hosted',
          reason: 'rate_limited',
          message: 'expansion used provider "hosted" because provider "subscription" hit a rate or usage limit',
        },
        // Nothing to say without a message; the line is skipped rather than invented.
        { type: 'model_fallback' },
      ],
      text: 'Facts (claim · source line; read slug:line for exact wording):\npeople/bo-winters — Bo Winters\n  L3 Bo Winters insures the boat with Vulpine Mutual.',
    });
    expect(text?.split('\n').slice(0, 3)).toEqual([
      'status: ok',
      'warning: expansion used provider "hosted" because provider "subscription" hit a rate or usage limit',
      '',
    ]);
    expect(tools().recall.description).toMatch(/model_fallback.*tell the user/i);
  });

  it('exposes Akno 0.11 managed-memory retraction by exact memory id', () => {
    const forget = tools().forget;
    const schema = forget.inputSchema as { shape: Record<string, unknown> };
    expect(schema.shape).toHaveProperty('memory');
    expect(forget.description).toMatch(/memory\.id.*as `memory`/i);
    expect(forget.description).toMatch(/plans, reports and questions.*no fact id/i);
  });

  it('passes the auto-recall profile and bounded conversation context through context', () => {
    const schema = tools().context.inputSchema as { shape: Record<string, unknown> };
    expect(schema.shape).toHaveProperty('profile');
    expect(schema.shape).toHaveProperty('conversation_context');
    expect(schema.shape).toHaveProperty('memory_view');
    expect(schema.shape).toHaveProperty('timeline_days');
    expect(schema.shape).toHaveProperty('structure');
    expect(tools().context.description).toMatch(/query-scoped recall.*without.*timeline.*structure/i);
  });

  it('says on `read` that a stored document costs no extraction', () => {
    // A filed PDF was being OCR'd again on every question about it. The text had been read on
    // arrival and was one call away; nothing in the surface said so, and `document` read as a
    // niche option rather than as the whole document, free.
    const description = tools().read.description!;
    expect(description).toMatch(/no extraction and no OCR/i);
    expect(description).toMatch(/complete stored text/i);
  });

  it('says on `remember` that returning nothing is normal', () => {
    // Otherwise a `noop` reads as a failure and the agent retries or apologizes.
    expect(tools().remember.description!).toMatch(/noop.*normal outcome|normal outcome, not a failure/is);
  });

  it('routes explicit identifier saves to write instead of conversational extraction', () => {
    expect(tools().remember.description).toMatch(/case number.*use write instead/i);
    expect(tools().write.description).toMatch(/case number.*self-contained declarative sentence/is);
  });

  it('edits one passage of a page without retyping the rest', () => {
    // Deleting one line used to mean resending a 200-line page through `content`. The retyped
    // copy invented two headings, and the whole-page conflict check refused it over a pair of
    // lines it had not changed.
    const write = tools().write;
    const schema = write.inputSchema as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> };
    expect(schema.shape.replace!.safeParse({ find: '- Blackwater Bay #Steam\n', with: '' }).success).toBe(true);
    expect(schema.shape.replace!.safeParse({ find: '', with: 'anything' }).success).toBe(false);
    expect(write.description).toMatch(/use replace: never retype a whole page/i);
  });

  it('saves references directly and requires readback confirmation', () => {
    const retain = tools().retain;
    const schema = retain.inputSchema as { shape: Record<string, unknown> };
    expect(schema.shape).toHaveProperty('text');
    expect(schema.shape).toHaveProperty('source_slug');
    expect(schema.shape).toHaveProperty('parts');
    expect(schema.shape).toHaveProperty('rows');
    expect(schema.shape).toHaveProperty('attempt');
    expect(retain.description).toMatch(/directly to one source page/i);
    expect(retain.description).toMatch(/does not run semantic fact extraction/i);
    expect(retain.description).toMatch(/`preserved: true` and `complete: true` after readback/i);
    const attempt = schema.shape.attempt as { description?: string };
    expect(attempt.description).toMatch(/uncertain transport error/i);
  });

  it('requires the destination field Akno actually accepts when ingesting', () => {
    const schema = tools().ingest.inputSchema as { shape: Record<string, unknown> };
    expect(schema.shape).toHaveProperty('folder');
    expect(schema.shape).not.toHaveProperty('slug');
    expect(tools().ingest.description).toMatch(/choose the destination folder yourself/i);
  });

  it('makes placement the agent’s decision rather than the owner’s', () => {
    expect(tools().answer_proposal.description).toMatch(/choose the best destination yourself/i);
    expect(tools().answer_proposal.description).toMatch(/do not ask the user/i);
  });

  it('reports an unreachable service as an outage, not as an empty result', async () => {
    process.env.AKNO_SOCKET = '/tmp/luna-test-no-such-memory.sock';
    const result = await tools().recall.handler({ query: 'anything at all' });

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toMatch(/not answering/i);
    expect(text).toMatch(/do not\s+conclude anything is absent/i);
    delete process.env.AKNO_SOCKET;
  });
});

describe('context scope', () => {
  it('defaults a focused product question to query evidence without ambient sections', () => {
    expect(
      contextRequest({
        query: 'Compare Zephyr QX-100 and Aster QX-200',
        mode: 'question',
        memory_view: 'factual',
        budget: 1600,
      }),
    ).toEqual({
      op: 'recall',
      input: {
        query: 'Compare Zephyr QX-100 and Aster QX-200',
        mode: 'question',
        memory_view: 'factual',
        budget: 1600,
      },
    });
    expect(contextRequest({ query: 'Compare Zephyr QX-100 and Aster QX-200' }).input).toMatchObject({
      budget: 20_000,
    });
  });

  it('allows a broad briefing and explicit ambient controls', () => {
    expect(contextRequest({ query: 'Household briefing', profile: 'default' })).toEqual({
      op: 'context',
      input: { query: 'Household briefing', profile: 'default' },
    });
    expect(contextRequest({})).toEqual({ op: 'context', input: {} });
    expect(contextRequest({ query: 'Recent decisions', timeline_days: 14, structure: true })).toEqual({
      op: 'context',
      input: {
        query: 'Recent decisions',
        profile: 'default',
        pinned: [],
        timeline_days: 14,
        structure: true,
      },
    });
    expect(contextRequest({ query: 'Recent decisions', timeline_days: 14 })).toEqual({
      op: 'context',
      input: {
        query: 'Recent decisions',
        profile: 'default',
        pinned: [],
        timeline_days: 14,
        structure: false,
      },
    });
    expect(contextRequest({ query: 'Available folders', structure: true })).toEqual({
      op: 'context',
      input: {
        query: 'Available folders',
        profile: 'default',
        pinned: [],
        timeline_days: 0,
        structure: true,
      },
    });
  });

  it('leaves precision-first automatic recall unchanged', () => {
    const input = { profile: 'auto_recall' as const, query: 'What is the warranty?' };
    expect(contextRequest(input)).toEqual({ op: 'context', input });
  });
});

/**
 * `ingest` is the only tool that takes a filesystem path, and the agent's only paths are
 * container paths. Memory runs on the host, so an inbound attachment used to fail with
 * `not_found` on a file the agent could see in its own `ls`.
 */
describe('ingesting a file the container can see', () => {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memtool-data-'));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-memtool-agent-'));
    fs.mkdirSync(path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'sessions/grp-1/sess-1/inbox/m-42/bill.pdf'), 'bytes');
  });

  afterEach(() => {
    for (const dir of [dataDir, agentDir]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const ingest = async (args: unknown, caller?: { agentGroupId: string; sessionId?: string }) => {
    const handler = tools().ingest.handler;
    return caller ? runAsCaller(caller, () => handler(args)) : handler(args);
  };

  it('resolves a /workspace path against the session it came from', async () => {
    const result = await ingest(
      { path: '/workspace/inbox/m-42/bill.pdf' },
      { agentGroupId: 'grp-1', sessionId: 'sess-1' },
    );
    // The service is down in a test run, so reaching the outage is how we know the path was
    // translated and handed on rather than refused here.
    expect(result.content[0]!.text).toMatch(/not answering/i);
  });

  it('says so plainly when a container path reaches nothing', async () => {
    // "no file at /workspace/..." for a path the agent can list reads as memory being broken.
    const result = await ingest({ path: '/workspace/inbox/m-99/ghost.pdf' }, { agentGroupId: 'grp-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/could not be resolved/i);
  });

  it('passes a URL through untouched', async () => {
    const result = await ingest({ path: 'https://example.com/a.pdf' }, { agentGroupId: 'grp-1' });
    expect(result.content[0]!.text).toMatch(/not answering/i);
  });
});
