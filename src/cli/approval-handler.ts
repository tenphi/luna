/**
 * Approval handler for agent-initiated CLI commands.
 *
 * On admin approve, re-dispatches the stored frame as host caller and writes
 * the cli_response back to the session DB so the container CLI client can pick
 * up the result.
 */
import { insertMessage } from '../db/session-db.js';
import { registerApprovalHandler, type ApprovalHandler } from '../modules/approvals/index.js';
import { openSession } from '../session-manager.js';
import { dispatch } from './dispatch.js';
import { parseBoolFlag } from './parse-bool-flag.js';
import type { RequestFrame, ResponseFrame } from './frame.js';

/**
 * Commands whose effect the agent cannot observe on its own after approval —
 * they change stored config that only applies on the next container start.
 */
const NOTIFY_ON_APPROVAL = new Set(['config-agent-add-package', 'config-agent-add-mcp-server']);

export function writeCliResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  frame: ResponseFrame,
): void {
  const db = openSession(agentGroupId, sessionId);
  try {
    insertMessage(db, {
      id: `cli-resp-${requestId}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({
        type: 'cli_response',
        requestId,
        frame,
      }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } finally {
    db.close();
  }
}

export const applyCliCommand: ApprovalHandler = async ({ session, payload, notify }) => {
  const frame = payload.frame as RequestFrame | undefined;
  if (!frame?.id || !frame.command) {
    notify('CLI command approval failed: missing command frame in payload.');
    return;
  }

  const response = await dispatch(frame, { caller: 'host' });
  writeCliResponse(session.agent_group_id, session.id, frame.id, response);

  if (!response.ok) {
    notify(`CLI command approved but failed: ${response.error.message}`);
    return;
  }

  // The cli_response row above is a dead letter for approvals: the container's
  // `luna` process gave up polling after 30s and exited long before the owner
  // tapped. Without an explicit notify, an approved config change lands
  // silently and the agent never learns it can retry.
  //
  // Skip it when a rebuild was requested: that path respawns the container with
  // its own on-wake `--message`, which is both more specific and already the
  // fresh container's first prompt. A second note would just be noise.
  const rebuilt = parseBoolFlag(frame.args?.rebuild);
  if (!rebuilt && NOTIFY_ON_APPROVAL.has(frame.command)) {
    notify(`Approved: \`luna ${frame.command.replace(/-/g, ' ')}\`. Takes effect after the next container restart.`);
  }
};

registerApprovalHandler('cli_command', applyCliCommand);
