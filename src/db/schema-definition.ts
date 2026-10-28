/** Database identifiers and constraints are compatibility data; this builder owns SQL generation. */
export type TableDefinition = {
  name: string;
  columns: [name: string, type: string, required: boolean, defaultValue: string | null][];
  primary: string[];
  unique?: string[][];
  foreign?: [column: string, table: string, target: string][];
  indexes?: { name: string; columns: string[]; unique?: boolean; where?: string }[];
  check?: string;
};
const quote = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unsafe schema identifier');
  return `"${name}"`;
};
const columns = (names: string[]): string => names.map(quote).join(', ');
export function tableSql(table: TableDefinition): string {
  const definitions = table.columns.map(
    ([name, type, required, initial]) =>
      `${quote(name)} ${type}${required ? ' NOT NULL' : ''}${initial === null ? '' : ` DEFAULT (${initial})`}`,
  );
  if (table.primary.length) definitions.push(`PRIMARY KEY (${columns(table.primary)})`);
  for (const key of table.unique ?? []) definitions.push(`UNIQUE (${columns(key)})`);
  for (const [column, target, field] of table.foreign ?? [])
    definitions.push(`FOREIGN KEY (${quote(column)}) REFERENCES ${quote(target)} (${quote(field)})`);
  if (table.check) definitions.push(`CHECK (${table.check})`);
  const statements = [`CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${definitions.join(',\n')});`];
  for (const index of table.indexes ?? [])
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(table.name)} (${columns(index.columns)})${index.where ? ` WHERE ${index.where}` : ''};`,
    );
  return statements.join('\n');
}
