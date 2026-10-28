import type { User } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { findRecord, insertRecord, updateRecords } from '../../../db/records.js';
export function createUser(user: User): void {
  insertRecord(getDb(), 'users', {
    ...user,
    platform_username: user.platform_username ?? null,
    user_key: user.user_key ?? null,
  });
}
export const getUser = (id: string): User | undefined => findRecord<User>(getDb(), 'users', { id });
export function upsertUser(user: User): void {
  const database = getDb();
  database.transaction(() => {
    if (!getUser(user.id)) {
      createUser(user);
      return;
    }
    updateRecords(
      database,
      'users',
      Object.fromEntries(
        ['display_name', 'platform_username', 'user_key'].flatMap((key) => {
          const value = user[key as keyof User];
          return value == null ? [] : [[key, value]];
        }),
      ),
      'id = ?',
      [user.id],
    );
  })();
}
export function setUserDisplayName(id: string, displayName: string): void {
  updateRecords(getDb(), 'users', { display_name: displayName }, 'id = ?', [id]);
}
