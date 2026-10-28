import { randomUUID } from 'node:crypto';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getInboundSourceSessionId, getMostRecentPeerSourceSessionId } from '../../db/session-db.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import {
  openSession,
  readOutboxFiles,
  resolveSession,
  stageInboxFile,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';
export { isSafeAttachmentName };
export type ForwardedAttachment = { type: 'file'; name: string; filename: string; localPath: string };
export type RoutableAgentMessage = {
  id: string;
  content: string;
  platform_id: string | null;
  in_reply_to: string | null;
};
type FileAddress = { agentGroupId: string; sessionId: string; messageId: string };
export function forwardAttachedFiles(
  source: FileAddress & { filenames: string[] },
  target: FileAddress,
): ForwardedAttachment[] {
  const files = readOutboxFiles(source.agentGroupId, source.sessionId, source.messageId, source.filenames) ?? [];
  return files.flatMap((file) => {
    const localPath = stageInboxFile(target.agentGroupId, target.sessionId, target.messageId, file);
    return localPath ? [{ type: 'file' as const, name: file.filename, filename: file.filename, localPath }] : [];
  });
}
function targetSession(message: RoutableAgentMessage, source: Session, agentId: string): Session {
  const handle = openSession(source.agent_group_id, source.id);
  let origin: string | null;
  try {
    origin =
      (message.in_reply_to ? getInboundSourceSessionId(handle, message.in_reply_to) : null) ??
      getMostRecentPeerSourceSessionId(handle, agentId);
  } finally {
    handle.close();
  }
  const existing = origin ? getSession(origin) : undefined;
  return existing?.agent_group_id === agentId && existing.status === 'active'
    ? existing
    : resolveSession(agentId, null, null, 'agent-shared').session;
}
function transferredContent(message: RoutableAgentMessage, source: Session, target: Session, id: string): string {
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return message.content;
  }
  if (
    !content ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    !('files' in content) ||
    !Array.isArray(content.files)
  )
    return message.content;
  const envelope = content as Record<string, unknown>;
  const filenames = content.files.filter((value): value is string => typeof value === 'string');
  const attachments = forwardAttachedFiles(
    { agentGroupId: source.agent_group_id, sessionId: source.id, messageId: message.id, filenames },
    { agentGroupId: target.agent_group_id, sessionId: target.id, messageId: id },
  );
  return JSON.stringify({
    ...envelope,
    attachments: [...(Array.isArray(envelope.attachments) ? envelope.attachments : []), ...attachments],
  });
}
export async function routeAgentMessage(message: RoutableAgentMessage, source: Session): Promise<void> {
  const recipient = message.platform_id;
  if (!recipient) throw new Error(`agent-to-agent message ${message.id} is missing a target agent group id`);
  if (recipient !== source.agent_group_id && !hasDestination(source.agent_group_id, 'agent', recipient))
    throw new Error(`unauthorized agent-to-agent: ${source.agent_group_id} has no destination for ${recipient}`);
  if (!getAgentGroup(recipient)) throw new Error(`target agent group ${recipient} not found for message ${message.id}`);
  const target = targetSession(message, source, recipient);
  const id = `a2a-${randomUUID()}`;
  const content = transferredContent(message, source, target, id);
  writeSessionMessage(recipient, target.id, {
    id,
    content,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'agent',
    platformId: source.agent_group_id,
    threadId: null,
    sourceSessionId: source.id,
  });
  log.info('Peer input queued', { source: source.agent_group_id, target: recipient, session: target.id });
  const current = getSession(target.id);
  if (current) await wakeContainer(current);
}
