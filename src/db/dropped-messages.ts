import { getDb } from './connection.js';
import { findRecord, upsertRecord } from './records.js';
type Dropped = {
  channel_type: string;
  platform_id: string;
  user_id: string | null;
  sender_name: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
};
export function recordDroppedMessage(message: Dropped): void {
  const database = getDb();
  database.transaction(() => {
    const previous = findRecord<Dropped & { message_count: number; first_seen: string }>(
      database,
      'unregistered_senders',
      { channel_type: message.channel_type, platform_id: message.platform_id },
    );
    const time = new Date().toISOString();
    upsertRecord(
      database,
      'unregistered_senders',
      {
        ...message,
        user_id: message.user_id ?? previous?.user_id ?? null,
        sender_name: message.sender_name ?? previous?.sender_name ?? null,
        messaging_group_id: previous ? previous.messaging_group_id : message.messaging_group_id,
        agent_group_id: previous ? previous.agent_group_id : message.agent_group_id,
        message_count: (previous?.message_count ?? 0) + 1,
        first_seen: previous?.first_seen ?? time,
        last_seen: time,
      },
      ['channel_type', 'platform_id'],
    );
  })();
}
