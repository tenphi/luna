import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { upsertRecord } from '../../../db/records.js';

export function upsertUserDm(row: UserDm): void {
  upsertRecord(getDb(), 'user_dms', { ...row }, ['user_id', 'channel_type']);
}
export function getUserDm(userId: string, channelType: string): UserDm | undefined {
  return getDb().prepare('SELECT * FROM user_dms WHERE channel_type=? AND user_id=?').get(channelType, userId) as
    | UserDm
    | undefined;
}
