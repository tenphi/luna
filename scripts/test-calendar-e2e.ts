/**
 * E2E test: wake a Telegram session with a calendar question.
 * Usage: pnpm exec tsx scripts/test-calendar-e2e.ts
 *
 * Set SESSION_ID (and optionally AGENT_GROUP_ID) for your install — defaults to luna-default.
 */
import path from 'path';

import { DEFAULT_GROUP_ID } from '../src/bootstrap.js';
import { initDb } from '../src/db/connection.js';
import { DATA_DIR } from '../src/config.js';
import { getSession } from '../src/db/sessions.js';
import { wakeContainer } from '../src/container-runner.js';
import { writeSessionMessage } from '../src/session-manager.js';

const AGENT_GROUP_ID = process.env.AGENT_GROUP_ID ?? DEFAULT_GROUP_ID;
const SESSION_ID = process.env.SESSION_ID ?? 'sess-0000000000000-example';

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'luna.db'));
  const session = getSession(SESSION_ID);
  if (!session) {
    console.error('Session not found:', SESSION_ID);
    process.exit(1);
  }

  const now = Date.now();
  writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, {
    id: `test-clear-${now}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      _type: 'chat:Message',
      id: `test:clear:${now}`,
      threadId: 'telegram:1000000001',
      text: '/clear',
      formatted: {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: '/clear' }] }],
      },
    }),
    trigger: 1,
  });

  const msgId = `test-cal-${now}`;
  writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, {
    id: msgId,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      _type: 'chat:Message',
      id: `test:${now}`,
      threadId: 'telegram:1000000001',
      text: 'What events do I have today?',
      formatted: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [{ type: 'text', value: 'What events do I have today?' }],
          },
        ],
      },
    }),
    trigger: 1,
  });

  console.log('Wrote inbound message', msgId);
  const ok = await wakeContainer(session);
  console.log('wakeContainer:', ok ? 'spawned' : 'failed/skipped');
  console.log('Watch: container logs $(container ls --quiet | grep luna- | head -1)');
  console.log('Then check the reply: pnpm exec tsx scripts/q.ts data/sessions/.../session.db "SELECT ... FROM messages_out"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
