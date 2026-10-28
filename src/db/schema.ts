import { tableSql, type TableDefinition } from './schema-definition.js';

export const SESSION_TABLES: TableDefinition[] = [
  {
    name: 'delivered',
    columns: [
      ['message_out_id', 'TEXT', false, null],
      ['platform_message_id', 'TEXT', false, null],
      ['status', 'TEXT', true, "'delivered'"],
      ['delivered_at', 'TEXT', true, null],
      ['resolved_at', 'TEXT', false, null],
      ['resolution_reason', 'TEXT', false, null],
    ],
    primary: ['message_out_id'],
  },
  {
    name: 'destinations',
    columns: [
      ['name', 'TEXT', false, null],
      ['display_name', 'TEXT', false, null],
      ['type', 'TEXT', true, null],
      ['channel_type', 'TEXT', false, null],
      ['platform_id', 'TEXT', false, null],
      ['agent_group_id', 'TEXT', false, null],
    ],
    primary: ['name'],
  },
  {
    name: 'messages_in',
    columns: [
      ['id', 'TEXT', false, null],
      ['seq', 'INTEGER', false, null],
      ['kind', 'TEXT', true, null],
      ['timestamp', 'TEXT', true, null],
      ['status', 'TEXT', false, "'pending'"],
      ['status_changed', 'TEXT', false, null],
      ['process_after', 'TEXT', false, null],
      ['recurrence', 'TEXT', false, null],
      ['series_id', 'TEXT', false, null],
      ['tries', 'INTEGER', false, '0'],
      ['trigger', 'INTEGER', true, '1'],
      ['platform_id', 'TEXT', false, null],
      ['channel_type', 'TEXT', false, null],
      ['thread_id', 'TEXT', false, null],
      ['content', 'TEXT', true, null],
      ['source_session_id', 'TEXT', false, null],
      ['on_wake', 'INTEGER', true, '0'],
    ],
    primary: ['id'],
    unique: [['seq']],
    indexes: [
      {
        name: 'idx_messages_in_series',
        columns: ['series_id'],
      },
    ],
  },
  {
    name: 'messages_out',
    columns: [
      ['id', 'TEXT', false, null],
      ['seq', 'INTEGER', false, null],
      ['in_reply_to', 'TEXT', false, null],
      ['timestamp', 'TEXT', true, null],
      ['deliver_after', 'TEXT', false, null],
      ['recurrence', 'TEXT', false, null],
      ['kind', 'TEXT', true, null],
      ['platform_id', 'TEXT', false, null],
      ['channel_type', 'TEXT', false, null],
      ['thread_id', 'TEXT', false, null],
      ['content', 'TEXT', true, null],
      ['delivery_attempts', 'INTEGER', true, '0'],
    ],
    primary: ['id'],
    unique: [['seq']],
  },
  {
    name: 'session_routing',
    columns: [
      ['id', 'INTEGER', false, null],
      ['channel_type', 'TEXT', false, null],
      ['platform_id', 'TEXT', false, null],
      ['thread_id', 'TEXT', false, null],
    ],
    primary: ['id'],
    check: 'id = 1',
  },
  {
    name: 'session_state',
    columns: [
      ['key', 'TEXT', false, null],
      ['value', 'TEXT', true, null],
      ['updated_at', 'TEXT', true, null],
    ],
    primary: ['key'],
  },
];

export const SESSION_SCHEMA = SESSION_TABLES.map(tableSql).join('\n');
