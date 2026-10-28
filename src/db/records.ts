import type Database from 'better-sqlite3';

type Values = Record<string, unknown>;
const identifier = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Invalid database identifier');
  return `"${name}"`;
};

/** Internal SQL construction; callers supply table/column names and bind every value. */
export function insertRecord(db: Database.Database, table: string, values: Values, ignore = false): number {
  const keys = Object.keys(values);
  const sql = `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${identifier(table)} (${keys.map(identifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((key) => values[key])).changes;
}

export function updateRecords(
  db: Database.Database,
  table: string,
  values: Values,
  predicate: string,
  parameters: unknown[],
): number {
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${identifier(table)} SET ${keys.map((key) => `${identifier(key)}=?`).join(',')} WHERE ${predicate}`;
  return db.prepare(sql).run(...keys.map((key) => values[key]), ...parameters).changes;
}

export function upsertRecord(db: Database.Database, table: string, values: Values, identity: string[]): void {
  const keys = Object.keys(values);
  const changed = keys.filter((key) => !identity.includes(key));
  const sql = `INSERT INTO ${identifier(table)} (${keys.map(identifier).join(',')}) VALUES (${keys.map(() => '?').join(',')}) ON CONFLICT (${identity.map(identifier).join(',')}) DO UPDATE SET ${changed.map((key) => `${identifier(key)}=excluded.${identifier(key)}`).join(',')}`;
  db.prepare(sql).run(...keys.map((key) => values[key]));
}

export function pickRecord(record: object, keys: string[]): Values {
  return Object.fromEntries(
    keys.filter((key) => (record as Values)[key] !== undefined).map((key) => [key, (record as Values)[key]]),
  );
}

export function findRecords<T>(
  db: Database.Database,
  table: string,
  criteria: Values,
  order?: { column: string; descending?: boolean },
  limit?: number,
): T[] {
  const keys = Object.keys(criteria);
  const filter = keys.length ? ` WHERE ${keys.map((key) => `${identifier(key)} IS ?`).join(' AND ')}` : '';
  const sorting = order ? ` ORDER BY ${identifier(order.column)} ${order.descending ? 'DESC' : 'ASC'}` : '';
  const bound = limit === undefined ? '' : ' LIMIT ?';
  return db
    .prepare(`SELECT * FROM ${identifier(table)}${filter}${sorting}${bound}`)
    .all(...Object.values(criteria), ...(limit === undefined ? [] : [limit])) as T[];
}

export const findRecord = <T>(db: Database.Database, table: string, criteria: Values): T | undefined =>
  findRecords<T>(db, table, criteria, undefined, 1)[0];
export function deleteRecords(db: Database.Database, table: string, criteria: Values): void {
  const keys = Object.keys(criteria);
  if (!keys.length) throw new Error('Record deletion requires an identity');
  db.prepare(
    `DELETE FROM ${identifier(table)} WHERE ${keys.map((key) => `${identifier(key)} IS ?`).join(' AND ')}`,
  ).run(...Object.values(criteria));
}
