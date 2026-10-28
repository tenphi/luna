/**
 * Regression lock on agent-facing prompt fragments.
 *
 * The agent once dead-ended on "install ImageMagick" — not because it lacked
 * the capability (`luna config agent add-package` has always been reachable in
 * agent scope) but because a fragment flatly told it "You cannot install
 * packages". Prompt text that lies about a capability is a real bug and an
 * invisible one, so it gets a test.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const FRAGMENT_DIRS = [
  path.join(process.cwd(), 'container', 'fragments'),
  path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools'),
];

function agentFacingMarkdown(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const dir of FRAGMENT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.md')) continue;
      out.push({ file: path.join(dir, entry), text: fs.readFileSync(path.join(dir, entry), 'utf8') });
    }
  }
  return out;
}

describe('agent-facing prompt guidance', () => {
  it('finds fragments to check', () => {
    expect(agentFacingMarkdown().length).toBeGreaterThan(0);
  });

  // A filed PDF was being OCR'd again on every question about it, because the memory
  // fragment described `memory_ingest` and never said the text comes back. The tool was
  // there; the sentence that made it reachable was not.
  it('says a stored document can be read back without extracting it', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');
    expect(memory).toContain('memory_read {document}');
    expect(memory).toMatch(/no extraction, no OCR/i);
  });

  // `attach_files` rides on `put_memory_page`, which needs an MCP server that no longer
  // exists — naming it sent the agent to a tool that is never in its surface.
  it('never names a memory tool the agent does not have', () => {
    const dirs = [path.join(process.cwd(), 'container', 'fragments'), path.join(process.cwd(), 'container', 'skills')];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md') && /\battach_files\b/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    for (const dir of dirs) walk(dir);
    expect(offenders).toEqual([]);
  });

  it('never tells the agent it cannot install packages', () => {
    const offenders = agentFacingMarkdown()
      .filter(({ text }) => /cannot install packages|can't install packages/i.test(text))
      .map(({ file }) => path.relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });

  it('documents the add-package escalation in the CLI fragment', () => {
    const cli = fs.readFileSync(
      path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'cli.instructions.md'),
      'utf8',
    );

    expect(cli).toContain('add-package');
    // The mechanical reason the agent gave up: approval-pending arrives as a
    // non-zero exit with an `error (...)` line, which reads as hard failure.
    expect(cli).toContain('approval-pending');
    expect(cli).toMatch(/not a failure/i);
  });

  // "Remind me to order X in 2 hours" produced a `schedule_task` and nothing
  // on the owner's list — the scheduling fragment was the only reminder-shaped
  // tool in the prompt, so the agent used it as one.
  it('sends user-facing reminders to the reminders list, not schedule_task', () => {
    const scheduling = fs.readFileSync(
      path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools', 'scheduling.instructions.md'),
      'utf8',
    );

    expect(scheduling).toContain('create_reminder');
    expect(scheduling).toMatch(/wakes \*?you\*?/i);

    const reminders = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'reminders.md'), 'utf8');
    expect(reminders).toContain('create_reminder');
    expect(reminders).toContain('due_date');
  });

  // An English message after non-English agenda entries can get a non-English
  // answer: the agenda blocks are injected on the *user* role
  // (providers/openai/index.ts:730,746) carrying event titles in whatever
  // language they were written, so they read as the user's own voice. Two
  // halves must both survive — name the blocks as fetched data, and write new
  // titles in English so the blocks stop accumulating the signal.
  it('keeps the reply-language rule anchored to the message, not the agenda blocks', () => {
    const base = fs.readFileSync(path.join(process.cwd(), 'container', 'AGENTS.md'), 'utf8');

    expect(base).toContain('<calendar-agenda>');
    expect(base).toContain('<reminders-agenda>');
    expect(base).toMatch(/user role/i);
    // The English-titles half, and the carve-out that stops it from becoming a
    // licence to retitle entries the owner wrote themselves.
    expect(base).toMatch(/calendar events and reminders you create/i);
    expect(base).toMatch(/never retitle/i);
  });

  it('tells the agent the ImageMagick policy denials are intentional', () => {
    const tools = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'tools.md'), 'utf8');

    expect(tools).toContain('not authorized by the security policy');
    expect(tools).toContain('pdftoppm');
  });

  // The `timeline` ledger spans years in one page. Reading it whole to answer
  // "when were we in Blackwater Bay" would spend a large slice of the turn's context, and
  // nothing clips a tool result in the turn that produces it — compaction only
  // rewrites the older region of history. So the fragment has to name the
  // filtered tool *and* rule out the two full reads.
  it('tells the agent to filter the timeline rather than read the ledger whole', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toContain('memory_timeline');
    expect(memory).toMatch(/never read the ledger whole/i);
    // Both escape hatches, named so neither reads as merely discouraged.
    expect(memory).toContain('memory_read {slug: "timeline"}');
    expect(memory).toMatch(/argument-less `memory_timeline`/i);
  });

  // A product review with a verdict, a comparison table and a source list was handed to
  // `memory_remember`, which files individual sentences by similarity — so it came back as loose
  // claims on a page titled after whichever sentence sorted first, and the verdict, the prices and
  // the comparison were gone. `memory_write {content}` was there the whole time. What was missing was
  // a sentence saying a report you wrote is a document, plus a qualification on the rule right above
  // it, which as written ("write prose, not tables of attributes") reads as forbidding the shape a
  // review needs.
  it('tells the agent to store a deliverable as a page it writes whole', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toContain('memory_write {slug, content}');
    expect(memory).toMatch(/never hand a deliverable to `memory_remember`/i);
    // The declaration that keeps a dated assessment out of the fact pipeline.
    expect(memory).toContain('akno.role: source');
    // The tables rule must stay scoped to claims, or it reads as a ban on the review's own shape.
    expect(memory).toMatch(/write prose, not tables of attributes\*\* — in a _claim_/i);
  });

  it('routes whole reference material through direct source storage and readback', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toContain('memory_retain {text, source_slug}');
    expect(memory).toMatch(/source page excluded from automatic fact extraction/i);
    expect(memory).toMatch(/`preserved: true` and `complete: true` after readback/i);
    expect(memory).toMatch(/cropped or unreadable source pixels cannot be improved by repeating/i);
    expect(memory).toMatch(/never acknowledge storage that the receipt did not confirm/i);
    expect(memory).toMatch(/automatic digest.*not a substitute for an explicit storage request/is);
    expect(memory).toMatch(/`memory_retain` and `memory_write`.*choose its meaningful page slug/i);
  });

  it('routes explicit case numbers through a confirmed direct write', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toMatch(/explicitly asks.*case number.*use `memory_write`/i);
    expect(memory).toMatch(/self-contained declarative sentence with the exact value/i);
    expect(memory).toMatch(/`memory_remember` `noop` confirms nothing was saved/i);
    expect(memory).toMatch(/try `memory_write` in the same turn/i);
  });

  it('explains protocol-v3 observations and their separate write authority', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toContain('akno.management.observe');
    expect(memory).toMatch(/derived L2 pattern, not direct authored fact/i);
    expect(memory).toMatch(/status.*eligible/i);
    expect(memory).toMatch(/does not authorize edits to surrounding prose/i);
  });

  it('explains protocol-v4 source-native retained-memory qualifications', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toMatch(/memory.*qualification.*source-native retention/i);
    expect(memory).toMatch(/status: unavailable.*do not use it as evidence/is);
    expect(memory).toMatch(/answer_eligible: false.*selected `memory_view`/is);
    expect(memory).toMatch(/preserve its `source_role`\/`source_speaker`, `commitment`, `disposition`/i);
    expect(memory).toMatch(
      /never restate a report, proposal, hypothesis, rejection or completed plan as a current fact/i,
    );
  });

  it('explains Akno 0.11 exact managed-memory retraction', () => {
    const memory = fs.readFileSync(path.join(process.cwd(), 'container', 'fragments', 'memory.md'), 'utf8');

    expect(memory).toContain('memory_forget');
    expect(memory).toMatch(/retained memory item.*\{memory\}/is);
    expect(memory).toContain('line.memory.id');
    expect(memory).toMatch(/plans, reports, questions, rejected options/i);
    expect(memory).toMatch(/not consent to delete its surrounding page/i);
  });

  it('ships product research with knowledge placement and verified storage guidance', () => {
    const skill = fs.readFileSync(path.join(process.cwd(), 'container/skills/product-review/SKILL.md'), 'utf8');
    expect(skill).toContain("knowledge base's placement and write policies");
    expect(skill).toContain('read back the page');
    expect(skill).toContain('do not claim durable storage');
  });

  // The test that used to sit here asserted a tool allowlist withheld `add_timeline_entry`, whose
  // writes went to a database row and never to the markdown, so entries made through it vanished on
  // the next rebuild. There is nothing to withhold now: the timeline is a file, memory writes the
  // file, and facts are derived from what is in it — the failure mode is structurally gone.
});
