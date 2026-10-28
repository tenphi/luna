/**
 * Render the live progress message from an ordered list of StatusLines.
 *
 * Rules:
 *   - The last line is always the active ticking line; everything above
 *     is frozen (completed).
 *   - Adjacent `thinking` lines are coalesced into one (merged duration).
 *   - Tool lines always occupy one line ("emoji Label · summary"), using the
 *     present-progressive label while active and the past-tense label once done.
 *   - `text` and `note` lines render as plain content without prefixes.
 *   - Live display uses a sliding window (min 10 StatusLines) under
 *     TELEGRAM_TEXT_CAP; omitted steps get a header line.
 *   - Collapsed done state: "✅ Done in {total}s" followed by tool outcomes.
 *
 * This module is pure / side-effect-free. All state and timing live in the
 * ProgressController; render functions receive already-computed data.
 */

export type LineKind = 'thinking' | 'generating' | 'tool' | 'reconnecting' | 'text' | 'note';

export interface StatusLine {
  kind: LineKind;
  emoji: string;
  /** Present-progressive label shown while the line is active ("Reading skill"). */
  label: string;
  /** Past-tense label shown once the line is frozen/done ("Skill used"). Falls back to `label`. */
  doneLabel?: string;
  summary: string;
  /** Epoch ms when this line became active. */
  startedAt: number;
  /** Set once the line is frozen (next line became active). */
  endedAt?: number;
  /** OpenAI tool_calls stream index for partial/full updates. */
  toolIndex?: number;
  /** True while the tool name is known but args are still streaming. */
  partial?: boolean;
}

/** Telegram editMessage text limit — keep headroom for multibyte chars. */
export const TELEGRAM_TEXT_CAP = 3800;

/** Minimum StatusLine rows kept before the sliding window drops older steps. */
export const MIN_VISIBLE_LINES = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsedSec(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function isPlainLine(line: StatusLine): boolean {
  return line.kind === 'text' || line.kind === 'note';
}

function renderPlain(line: StatusLine): string[] {
  return line.summary ? [line.summary] : [];
}

function renderActive(line: StatusLine, now: number): string[] {
  if (isPlainLine(line)) return renderPlain(line);
  const sec = elapsedSec(line.startedAt, now);
  const timer = sec > 0 ? ` ${sec}s` : '';
  // Tool lines always occupy a single line: "emoji ActiveLabel · summary Ns".
  // The present-progressive label already implies "in progress", so no "…".
  if (line.kind === 'tool') {
    const summary = line.summary ? ` · ${line.summary}` : '';
    return [`${line.emoji} ${line.label}${summary}${timer}`];
  }
  const first = `${line.emoji} ${line.label}…${timer}`;
  return line.summary ? [first, `   ${line.summary}`] : [first];
}

function renderFrozen(line: StatusLine): string[] {
  if (isPlainLine(line)) return renderPlain(line);
  // Completed tool lines collapse to a single past-tense line, no check/timer:
  // "emoji DoneLabel · summary". The verb shift (active → past) is the "done"
  // signal (green ✓ + timer were too noisy). Other frozen lines keep the check.
  if (line.kind === 'tool') {
    const label = line.doneLabel ?? line.label;
    const summary = line.summary ? ` · ${line.summary}` : '';
    return [`${line.emoji} ${label}${summary}`];
  }
  const sec = line.endedAt !== undefined ? elapsedSec(line.startedAt, line.endedAt) : 0;
  const timer = sec > 0 ? ` ${sec}s` : '';
  const first = `${line.emoji} ${line.label} ✓${timer}`;
  return line.summary ? [first, `   ${line.summary}`] : [first];
}

/** Merge adjacent thinking rows for live display (controller history unchanged). */
export function collapseConsecutiveThinking(lines: StatusLine[]): StatusLine[] {
  const out: StatusLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (line.kind === 'thinking' && prev?.kind === 'thinking') {
      if (line.endedAt === undefined) {
        prev.endedAt = undefined;
      } else {
        prev.endedAt = line.endedAt;
      }
      continue;
    }
    out.push({ ...line });
  }
  return out;
}

function renderLiveInner(lines: StatusLine[], now: number): string {
  if (lines.length === 0) return '';

  const result: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    result.push(...renderFrozen(lines[i]!));
  }
  result.push(...renderActive(lines[lines.length - 1]!, now));
  return result.join('\n');
}

function omittedHeaderLen(omitted: number): number {
  return omitted > 0 ? `… ${omitted} earlier steps\n`.length : 0;
}

function fitsTelegramCap(lines: StatusLine[], now: number, omitted: number): boolean {
  return omittedHeaderLen(omitted) + renderLiveInner(lines, now).length <= TELEGRAM_TEXT_CAP;
}

/**
 * Drop oldest StatusLines until the rendered text fits TELEGRAM_TEXT_CAP.
 * Prefers keeping at least MIN_VISIBLE_LINES while under cap; char limit wins
 * when even MIN_VISIBLE_LINES would overflow.
 */
export function windowLinesForDisplay(lines: StatusLine[], now: number): { lines: StatusLine[]; omitted: number } {
  let windowed = lines;
  let omitted = 0;

  while (windowed.length > MIN_VISIBLE_LINES) {
    if (fitsTelegramCap(windowed, now, omitted)) {
      return { lines: windowed, omitted };
    }
    windowed = windowed.slice(1);
    omitted++;
  }

  while (windowed.length > 1) {
    if (fitsTelegramCap(windowed, now, omitted)) {
      return { lines: windowed, omitted };
    }
    windowed = windowed.slice(1);
    omitted++;
  }

  return { lines: windowed, omitted };
}

// ---------------------------------------------------------------------------
// Live render (while turn is in progress)
// ---------------------------------------------------------------------------

/**
 * Render the current live state of the progress message.
 * All lines except the last are frozen; the last is active.
 */
export function renderLive(lines: StatusLine[], now: number): string {
  const collapsed = collapseConsecutiveThinking(lines);
  const { lines: windowed, omitted } = windowLinesForDisplay(collapsed, now);
  const header = omitted > 0 ? `… ${omitted} earlier steps\n` : '';
  const bodyBudget = TELEGRAM_TEXT_CAP - header.length;
  let text = renderLiveInner(windowed, now);

  if (text.length > bodyBudget) {
    text = text.slice(-bodyBudget);
  }

  return header + text;
}

// ---------------------------------------------------------------------------
// Collapsed done render
// ---------------------------------------------------------------------------

/**
 * Render the final collapsed state: "✅ Done in {total}s" plus tool
 * outcome lines (emoji · label · summary). Plain interim lines are dropped.
 *
 * @param lines   All lines that ran during the turn.
 * @param t0      Epoch ms of the user's triggering message (turn start).
 * @param doneAt  Epoch ms when the turn finished.
 */
export function renderDone(lines: StatusLine[], t0: number, doneAt: number, effort?: string): string {
  const totalSec = Math.max(0, Math.floor((doneAt - t0) / 1000));
  const header = `✅ Done in ${totalSec}s${effort ? ` · reasoning: ${effort}` : ''}`;

  const toolLines = lines
    .filter((l) => l.kind === 'tool')
    .map((l) => `${l.emoji} ${l.doneLabel ?? l.label}${l.summary ? ' · ' + l.summary : ''}`);

  return [header, ...toolLines].join('\n');
}

/**
 * Terminal render for a turn that was cut short — container killed by the
 * sweep, container crashed, retry budget exhausted.
 *
 * The sweep used to close these bubbles with `renderDone`, so a turn that
 * produced no answer at all signed off with "✅ Done in 132s". The user was
 * left looking at a checkmark and an empty chat, with nothing to distinguish
 * it from a reply that got lost in delivery.
 *
 * `note` carries what happens next ("retrying in 20s") when the sweep has
 * already scheduled it.
 */
export function renderInterrupted(lines: StatusLine[], t0: number, at: number, note?: string): string {
  const totalSec = Math.max(0, Math.floor((at - t0) / 1000));
  const header = `⚠️ Interrupted after ${totalSec}s${note ? ` · ${note}` : ''}`;

  const toolLines = lines
    .filter((l) => l.kind === 'tool')
    .map((l) => `${l.emoji} ${l.doneLabel ?? l.label}${l.summary ? ' · ' + l.summary : ''}`);

  return [header, ...toolLines].join('\n');
}

// ---------------------------------------------------------------------------
// CLI compact summary (single dim line shown on stderr after the answer)
// ---------------------------------------------------------------------------

/**
 * One-liner for the CLI done state: "✅ Done in {total}s · 🧠 Search · 📅 List events"
 */
export function renderCliDone(lines: StatusLine[], t0: number, doneAt: number, effort?: string): string {
  const totalSec = Math.max(0, Math.floor((doneAt - t0) / 1000));
  const toolParts = lines.filter((l) => l.kind === 'tool').map((l) => `${l.emoji} ${l.doneLabel ?? l.label}`);
  const suffix = toolParts.length > 0 ? ` · ${toolParts.join(' · ')}` : '';
  return `✅ Done in ${totalSec}s${effort ? ` · reasoning: ${effort}` : ''}${suffix}`;
}

/** CLI counterpart of renderInterrupted — one line, same information. */
export function renderCliInterrupted(lines: StatusLine[], t0: number, at: number, note?: string): string {
  const totalSec = Math.max(0, Math.floor((at - t0) / 1000));
  const toolParts = lines.filter((l) => l.kind === 'tool').map((l) => `${l.emoji} ${l.doneLabel ?? l.label}`);
  const parts = [...(note ? [note] : []), ...toolParts];
  const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  return `⚠️ Interrupted after ${totalSec}s${suffix}`;
}
