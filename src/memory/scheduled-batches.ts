import type { ScheduledEvidence } from './scheduled-evidence.js';

export interface ScheduledReportItem {
  item_id: string;
  text: string;
  role: 'assistant';
  speaker: string;
  mentioned_at?: string;
}

/** Bounded requests retain complete connected source groups, never prefixes of original emails. */
export function scheduledBatches(evidence: ScheduledEvidence, reports: ScheduledReportItem[]) {
  const emails = evidence.emails;
  const parent = emails.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
  const join = (left: number, right: number) => {
    parent[root(left)] = root(right);
  };
  const indices = new Map(emails.map((email, index) => [email.item_id, index]));
  for (let i = 0; i < emails.length; i++)
    for (let j = 0; j < i; j++) {
      if (emails[i]!.thread_id && emails[i]!.thread_id === emails[j]!.thread_id) join(i, j);
    }
  for (const finding of evidence.findings ?? []) {
    const members = finding.item_ids
      .map((id) => indices.get(id))
      .filter((index): index is number => index !== undefined);
    for (const member of members.slice(1)) join(members[0]!, member);
  }
  const groups = new Map<number, typeof emails>();
  for (const [index, email] of emails.entries()) {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), email]);
  }
  type Item = Omit<(typeof emails)[number], 'thread_id'> | ScheduledReportItem;
  const batches: Item[][] = [];
  let batch: Item[] = [];
  let oversizedGroups = 0;
  let oversizedEmails = 0;
  // Findings whose originals are all missing have no email root to visit below.
  let incompleteGroups = (evidence.findings ?? []).filter((finding) =>
    finding.item_ids.every((id) => !indices.has(id)),
  ).length;
  const incompleteRoots = new Set(
    (evidence.findings ?? [])
      .filter((finding) => finding.item_ids.some((id) => !indices.has(id)))
      .flatMap((finding) => finding.item_ids.flatMap((id) => (indices.has(id) ? [root(indices.get(id)!)] : []))),
  );
  const size = (items: Item[]) => JSON.stringify({ kind: 'structured', items }).length;
  const append = (unit: Item[]) => {
    if (size(unit) > 110_000) {
      oversizedGroups++;
      oversizedEmails += unit.filter((item) => item.role === 'external').length;
      return;
    }
    const combined = [...new Map([...batch, ...unit].map((item) => [item.item_id, item])).values()];
    if (batch.length && size(combined) > 64_000) {
      batches.push(batch);
      batch = unit;
    } else batch = combined;
  };
  for (const [key, group] of groups) {
    if (incompleteRoots.has(key)) {
      incompleteGroups++;
      continue;
    }
    const ids = new Set(group.map((email) => email.item_id));
    const findings = (evidence.findings ?? []).filter((finding) => finding.item_ids.some((id) => ids.has(id)));
    const selectedReports = findings.length
      ? findings.map((finding, index) => ({
          ...reports[0]!,
          item_id: `finding:${group[0]!.item_id}:${index}`,
          text: finding.text,
        }))
      : reports;
    const uniqueReports = [...new Map(selectedReports.map((report) => [report.item_id, report])).values()];
    append([...group.map(({ thread_id: _threadId, ...email }) => email), ...uniqueReports]);
  }
  if (!groups.size && !incompleteGroups) for (const report of reports) append([report]);
  if (batch.length) batches.push(batch);
  // An oversize source still has an explicit status source; originals remain durable in the report.
  if (!batches.length)
    batches.push([
      {
        item_id: 'evidence-unavailable',
        text: 'No complete evidence group fits the retention context. Do not infer findings from this status.',
        role: 'assistant',
        speaker: 'Luna',
      },
    ]);
  return { batches, oversizedGroups, oversizedEmails, incompleteGroups };
}
