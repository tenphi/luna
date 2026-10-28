/**
 * Telling the owner that someone they have not configured tried to talk to Luna.
 *
 * This replaces the Allow/Deny card. The card was an admission decision taken in a chat, which is
 * exactly what moving the roster into config was meant to end — but silence is worse than a card: a
 * message that vanishes with no trace anywhere the operator looks is indistinguishable from Luna
 * being broken. So the owner is told, once, with enough to act on.
 *
 * "Once" is per sender, not per chat, which is why this has its own table rather than reusing
 * `unregistered_senders`.
 */
import { getDb } from '../../db/connection.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';

/** Suggest a config key from a display name or handle, so the message can be copy-pasted. */
function suggestKey(senderName: string | null, userId: string): string {
  const raw = senderName?.trim() || userId.split(':').slice(1).join(':') || 'someone';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')[0];
  return slug || 'someone';
}

/** True when this sender has not been reported before, and marks them reported. */
function claimNotice(channelType: string, senderId: string, senderName: string | null): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO roster_notices (channel_type, sender_id, sender_name, notified_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(channelType, senderId, senderName, new Date().toISOString());
  return result.changes > 0;
}

export interface RosterNoticeInput {
  channelType: string;
  /** Namespaced sender id, e.g. `telegram:1000000001`. */
  userId: string | null;
  senderName: string | null;
  /** Chat the message arrived in, for the "where" half of the message. */
  platformId: string;
  /** True when the roster names them but `enabled: false`. */
  disabled?: boolean;
}

/**
 * Fire-and-forget. Failure to deliver is logged and never propagated: the sender's message is dropped
 * either way, and a broken notice must not become a second way for inbound routing to fail.
 */
export async function notifyOwnerOfUnknownSender(input: RosterNoticeInput): Promise<void> {
  // A sender we could not even identify has nothing to add to config, so there is nothing to say.
  if (!input.userId) return;
  // Already refused deliberately — the owner set `enabled: false` themselves and does not need
  // telling every time that took effect.
  if (input.disabled) return;

  if (!claimNotice(input.channelType, input.userId, input.senderName)) return;

  const approvers = pickApprover().filter((id) => id !== CLI_LOCAL_USER_ID);
  if (approvers.length === 0) {
    log.info('Unknown sender not reported — no owner reachable on a chat channel', { userId: input.userId });
    return;
  }

  const target = await pickApprovalDelivery(approvers, input.channelType);
  if (!target) {
    log.info('Unknown sender not reported — owner has no reachable DM', { userId: input.userId });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) return;

  const who = input.senderName ? `${input.senderName} (${input.userId})` : input.userId;
  const key = suggestKey(input.senderName, input.userId);

  // The handle, when the platform gave us one. With it, the config line alone is enough and the
  // binding happens on their next message; without it — a Telegram account with no public @username —
  // `luna users bind` is the only way in, which is precisely when it needs to be spelled out.
  const stored = getDb().prepare('SELECT platform_username FROM users WHERE id = ?').get(input.userId) as
    | { platform_username: string | null }
    | undefined;
  const handle = stored?.platform_username ?? null;

  // Plain text, not a card: there is no button that could admit them. The action is an edit to config
  // on the host, and the message's job is to make that edit obvious rather than to collect a tap.
  const lines = [
    `${who} messaged me and isn't in your roster, so I didn't reply.`,
    '',
    'To let them in, on the host:',
    `  luna config users set --key ${key} --name "${input.senderName ?? key}"` +
      (handle ? ` --telegram-handle ${handle}` : ''),
  ];
  if (!handle) {
    lines.push(`  luna users bind --user ${input.userId} --key ${key}   # no public @username to match on`);
  }
  lines.push('', "I'll only mention this person once.");
  const text = lines.join('\n');

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({ text }),
    );
    log.info('Reported an unknown sender to the owner', { userId: input.userId, owner: target.userId });
  } catch (err) {
    log.warn('Could not report an unknown sender to the owner', { userId: input.userId, err });
  }
}
