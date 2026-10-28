import fs from 'fs';

import { getSession } from '../../db/sessions.js';
import { dismissFailedDelivery, ensureSchema, openSessionDb } from '../../db/session-db.js';
import { sessionDbPath } from '../../session-manager.js';
import type { CallerContext } from '../frame.js';
import { register } from '../registry.js';

function required(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Pass --${key}`);
  return value.trim();
}

function withSession<T>(sessionId: string, ctx: CallerContext, fn: (db: ReturnType<typeof openSessionDb>) => T): T {
  if (ctx.caller !== 'host') throw new Error('Delivery recovery is available only on the host');
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const dbPath = sessionDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(dbPath)) throw new Error(`Session database not found: ${sessionId}`);
  ensureSchema(dbPath);
  const db = openSessionDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

register({
  name: 'deliveries-list',
  description: 'Inspect failed deliveries for --session; --all includes dismissed failures and their resolution',
  access: 'open',
  parseArgs: (raw) => ({ session: required(raw, 'session'), all: raw.all === true }),
  handler: async (args, ctx) =>
    withSession(args.session, ctx, (db) =>
      db
        .prepare(
          `SELECT m.id, m.seq, m.timestamp, m.kind, m.channel_type, m.delivery_attempts,
                  d.status, d.delivered_at AS failed_at, d.resolved_at, d.resolution_reason
           FROM delivered d JOIN messages_out m ON m.id = d.message_out_id
           WHERE d.status = 'failed' OR (? = 1 AND d.status = 'dismissed')
           ORDER BY m.seq`,
        )
        .all(args.all ? 1 : 0),
    ),
});

register({
  name: 'deliveries-dismiss',
  description: 'Dismiss one reviewed obsolete failed delivery: --session --id --reason. Retains history; sends nothing',
  access: 'open',
  parseArgs: (raw) => ({
    session: required(raw, 'session'),
    id: required(raw, 'id'),
    reason: required(raw, 'reason'),
  }),
  handler: async (args, ctx) =>
    withSession(args.session, ctx, (db) => ({
      id: args.id,
      status: 'dismissed',
      changed: dismissFailedDelivery(db, args.id, args.reason),
    })),
});
