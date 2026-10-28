import type Database from 'better-sqlite3';

import { CENTRAL_SCHEMA, CENTRAL_TABLES } from './central-schema.js';
import { SESSION_SCHEMA, SESSION_TABLES } from './schema.js';
import type { TableDefinition } from './schema-definition.js';

export const DATABASE_SCHEMA_VERSION = 1;

type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
const normalizedDefault = (value: string | null): string | null =>
  value === null ? null : value.replace(/^\((.*)\)$/s, '$1');

/** Verify the baseline without modifying an existing database. */
function checkTables(database: Database.Database, tables: TableDefinition[]): void {
  const names = (
    database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map(({ name }) => name);
  if (names.length !== tables.length || tables.some(({ name }) => !names.includes(name))) {
    throw new Error(
      'Database tables do not match Luna’s public schema. Use a compatible installation or restore its backup.',
    );
  }
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info("${table.name}")`).all() as Column[];
    if (
      columns.length !== table.columns.length ||
      table.columns.some(([name, type, required, initial]) => {
        const column = columns.find((entry) => entry.name === name);
        return (
          !column ||
          column.type.toUpperCase() !== type ||
          Boolean(column.notnull) !== required ||
          normalizedDefault(column.dflt_value) !== normalizedDefault(initial) ||
          column.pk !== (table.primary.includes(name) ? table.primary.indexOf(name) + 1 : 0)
        );
      })
    ) {
      throw new Error(
        'Database columns do not match Luna’s public schema. Use a compatible installation or restore its backup.',
      );
    }
  }
}

function initialize(database: Database.Database, schema: string, tables: TableDefinition[], seed?: () => void): void {
  const version = database.pragma('user_version', { simple: true }) as number;
  const populated = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get(),
  );
  if (version === 0 && !populated) {
    database.transaction(() => {
      database.exec(schema);
      seed?.();
      database.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
    })();
  } else if (version !== DATABASE_SCHEMA_VERSION) {
    throw new Error('Unsupported Luna database version. Pre-release state must be upgraded before using this release.');
  }
  checkTables(database, tables);
}

/** New installs start at the complete public schema, without historical upgrades. */
export function initializeCentralSchema(database: Database.Database): void {
  initialize(database, CENTRAL_SCHEMA, CENTRAL_TABLES, () => {
    database
      .prepare('INSERT INTO install_settings (id, mcp_tool_filters, updated_at) VALUES (?, ?, ?)')
      .run(1, '{}', new Date().toISOString());
  });
}

export function initializeSessionSchema(database: Database.Database): void {
  initialize(database, SESSION_SCHEMA, SESSION_TABLES);
}
