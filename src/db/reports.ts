/**
 * Session reports — `/report <complaint>`, kept so they can be worked through later.
 *
 * The value is in the aggregate: one complaint is an anecdote, five that name the same behaviour is
 * a bug with a reproduction. So a report records *where* it came from — session, agent group,
 * messaging group, user — and a slice of the exchange that prompted it, because sessions are
 * garbage-collected and a complaint with no example is one nobody can act on.
 */
import { getDb } from './connection.js';

export interface Report {
  id: string;
  created_at: string;
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  user_id: string | null;
  complaint: string;
  context: string | null;
  status: string;
  resolved_at: string | null;
  resolution: string | null;
}

export function createReport(input: {
  id: string;
  session_id: string;
  agent_group_id: string;
  messaging_group_id?: string | null;
  user_id?: string | null;
  complaint: string;
  context?: string | null;
}): Report {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO reports (id, created_at, session_id, agent_group_id, messaging_group_id, user_id, complaint, context, status)
       VALUES (@id, @created_at, @session_id, @agent_group_id, @messaging_group_id, @user_id, @complaint, @context, 'open')`,
    )
    .run({
      id: input.id,
      created_at: now,
      session_id: input.session_id,
      agent_group_id: input.agent_group_id,
      messaging_group_id: input.messaging_group_id ?? null,
      user_id: input.user_id ?? null,
      complaint: input.complaint,
      context: input.context ?? null,
    });
  return getReport(input.id)!;
}

export function getReport(id: string): Report | null {
  return (getDb().prepare('SELECT * FROM reports WHERE id = ?').get(id) as Report | undefined) ?? null;
}

/** Open first and newest first — the order somebody triaging them wants. */
export function listReports(status?: string, limit = 50): Report[] {
  return status
    ? (getDb()
        .prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC LIMIT ?')
        .all(status, limit) as Report[])
    : (getDb()
        .prepare("SELECT * FROM reports ORDER BY status = 'resolved', created_at DESC LIMIT ?")
        .all(limit) as Report[]);
}

export function resolveReport(id: string, resolution: string | null): Report | null {
  getDb()
    .prepare("UPDATE reports SET status = 'resolved', resolved_at = ?, resolution = ? WHERE id = ?")
    .run(new Date().toISOString(), resolution, id);
  return getReport(id);
}

export function countOpenReports(): number {
  return (getDb().prepare("SELECT count(*) AS n FROM reports WHERE status = 'open'").get() as { n: number }).n;
}
