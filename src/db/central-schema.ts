import { tableSql, type TableDefinition } from './schema-definition.js';

export const CENTRAL_TABLES: TableDefinition[] = [
  {
    name: 'agent_destinations',
    columns: [
      ['agent_group_id', 'TEXT', true, null],
      ['local_name', 'TEXT', true, null],
      ['target_type', 'TEXT', true, null],
      ['target_id', 'TEXT', true, null],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['agent_group_id', 'local_name'],
    foreign: [['agent_group_id', 'agent_groups', 'id']],
    indexes: [
      {
        name: 'idx_agent_dest_target',
        columns: ['target_type', 'target_id'],
      },
    ],
  },
  {
    name: 'agent_groups',
    columns: [
      ['id', 'TEXT', false, null],
      ['name', 'TEXT', true, null],
      ['agent_provider', 'TEXT', false, null],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['id'],
  },
  {
    name: 'chat_sdk_kv',
    columns: [
      ['key', 'TEXT', false, null],
      ['value', 'TEXT', true, null],
      ['expires_at', 'INTEGER', false, null],
    ],
    primary: ['key'],
  },
  {
    name: 'chat_sdk_lists',
    columns: [
      ['key', 'TEXT', true, null],
      ['idx', 'INTEGER', true, null],
      ['value', 'TEXT', true, null],
      ['expires_at', 'INTEGER', false, null],
    ],
    primary: ['key', 'idx'],
  },
  {
    name: 'chat_sdk_locks',
    columns: [
      ['thread_id', 'TEXT', false, null],
      ['token', 'TEXT', true, null],
      ['expires_at', 'INTEGER', true, null],
    ],
    primary: ['thread_id'],
  },
  {
    name: 'chat_sdk_subscriptions',
    columns: [
      ['thread_id', 'TEXT', false, null],
      ['subscribed_at', 'TEXT', true, "datetime('now')"],
    ],
    primary: ['thread_id'],
  },
  {
    name: 'install_settings',
    columns: [
      ['id', 'INTEGER', false, null],
      ['mcp_tool_filters', 'TEXT', true, "'{}'"],
      ['updated_at', 'TEXT', true, null],
    ],
    primary: ['id'],
    check: 'id = 1',
  },
  {
    name: 'messaging_group_agents',
    columns: [
      ['id', 'TEXT', false, null],
      ['messaging_group_id', 'TEXT', true, null],
      ['agent_group_id', 'TEXT', true, null],
      ['engage_mode', 'TEXT', true, "'mention'"],
      ['engage_pattern', 'TEXT', false, null],
      ['ignored_message_policy', 'TEXT', true, "'drop'"],
      ['session_mode', 'TEXT', false, "'shared'"],
      ['priority', 'INTEGER', false, '0'],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['id'],
    unique: [['messaging_group_id', 'agent_group_id']],
    foreign: [
      ['agent_group_id', 'agent_groups', 'id'],
      ['messaging_group_id', 'messaging_groups', 'id'],
    ],
  },
  {
    name: 'messaging_groups',
    columns: [
      ['id', 'TEXT', false, null],
      ['channel_type', 'TEXT', true, null],
      ['platform_id', 'TEXT', true, null],
      ['name', 'TEXT', false, null],
      ['is_group', 'INTEGER', false, '0'],
      ['denied_at', 'TEXT', false, null],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['id'],
    unique: [['channel_type', 'platform_id']],
  },
  {
    name: 'pending_approvals',
    columns: [
      ['approval_id', 'TEXT', false, null],
      ['kind', 'TEXT', true, "'action'"],
      ['session_id', 'TEXT', false, null],
      ['request_id', 'TEXT', true, null],
      ['action', 'TEXT', true, null],
      ['payload', 'TEXT', true, null],
      ['created_at', 'TEXT', true, null],
      ['agent_group_id', 'TEXT', false, null],
      ['messaging_group_id', 'TEXT', false, null],
      ['sender_identity', 'TEXT', false, null],
      ['sender_name', 'TEXT', false, null],
      ['original_message', 'TEXT', false, null],
      ['approver_user_id', 'TEXT', false, null],
      ['channel_type', 'TEXT', false, null],
      ['platform_id', 'TEXT', false, null],
      ['platform_message_id', 'TEXT', false, null],
      ['expires_at', 'TEXT', false, null],
      ['status', 'TEXT', true, "'pending'"],
      ['title', 'TEXT', true, "''"],
      ['options_json', 'TEXT', true, "'[]'"],
    ],
    primary: ['approval_id'],
    foreign: [
      ['messaging_group_id', 'messaging_groups', 'id'],
      ['agent_group_id', 'agent_groups', 'id'],
      ['session_id', 'sessions', 'id'],
    ],
    indexes: [
      {
        name: 'idx_pending_approvals_kind_status',
        columns: ['kind', 'status'],
      },
      {
        name: 'idx_pending_approvals_action_status',
        columns: ['action', 'status'],
      },
    ],
  },
  {
    name: 'pending_questions',
    columns: [
      ['question_id', 'TEXT', false, null],
      ['session_id', 'TEXT', true, null],
      ['message_out_id', 'TEXT', true, null],
      ['platform_id', 'TEXT', false, null],
      ['channel_type', 'TEXT', false, null],
      ['thread_id', 'TEXT', false, null],
      ['title', 'TEXT', true, null],
      ['options_json', 'TEXT', true, null],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['question_id'],
    foreign: [['session_id', 'sessions', 'id']],
  },
  {
    name: 'reports',
    columns: [
      ['id', 'TEXT', false, null],
      ['created_at', 'TEXT', true, null],
      ['session_id', 'TEXT', true, null],
      ['agent_group_id', 'TEXT', true, null],
      ['messaging_group_id', 'TEXT', false, null],
      ['user_id', 'TEXT', false, null],
      ['complaint', 'TEXT', true, null],
      ['context', 'TEXT', false, null],
      ['status', 'TEXT', true, "'open'"],
      ['resolved_at', 'TEXT', false, null],
      ['resolution', 'TEXT', false, null],
    ],
    primary: ['id'],
    indexes: [
      {
        name: 'idx_reports_status',
        columns: ['status', 'created_at'],
      },
    ],
  },
  {
    name: 'roster_notices',
    columns: [
      ['channel_type', 'TEXT', true, null],
      ['sender_id', 'TEXT', true, null],
      ['sender_name', 'TEXT', false, null],
      ['notified_at', 'TEXT', true, null],
    ],
    primary: ['channel_type', 'sender_id'],
  },
  {
    name: 'sessions',
    columns: [
      ['id', 'TEXT', false, null],
      ['agent_group_id', 'TEXT', true, null],
      ['messaging_group_id', 'TEXT', false, null],
      ['thread_id', 'TEXT', false, null],
      ['agent_provider', 'TEXT', false, null],
      ['status', 'TEXT', false, "'active'"],
      ['container_status', 'TEXT', false, "'stopped'"],
      ['last_active', 'TEXT', false, null],
      ['ephemeral', 'INTEGER', true, '0'],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['id'],
    foreign: [
      ['messaging_group_id', 'messaging_groups', 'id'],
      ['agent_group_id', 'agent_groups', 'id'],
    ],
    indexes: [
      {
        name: 'idx_sessions_lookup',
        columns: ['messaging_group_id', 'thread_id'],
      },
      {
        name: 'idx_sessions_agent_group',
        columns: ['agent_group_id'],
      },
    ],
  },
  {
    name: 'unregistered_senders',
    columns: [
      ['channel_type', 'TEXT', true, null],
      ['platform_id', 'TEXT', true, null],
      ['user_id', 'TEXT', false, null],
      ['sender_name', 'TEXT', false, null],
      ['reason', 'TEXT', true, null],
      ['messaging_group_id', 'TEXT', false, null],
      ['agent_group_id', 'TEXT', false, null],
      ['message_count', 'INTEGER', true, '1'],
      ['first_seen', 'TEXT', true, null],
      ['last_seen', 'TEXT', true, null],
    ],
    primary: ['channel_type', 'platform_id'],
    indexes: [
      {
        name: 'idx_unregistered_senders_last_seen',
        columns: ['last_seen'],
      },
    ],
  },
  {
    name: 'usage_daily',
    columns: [
      ['day', 'TEXT', true, null],
      ['agent_group_id', 'TEXT', true, null],
      ['session_id', 'TEXT', true, null],
      ['episode_id', 'TEXT', true, "''"],
      ['provider', 'TEXT', true, null],
      ['model', 'TEXT', true, "''"],
      ['prompt_tokens', 'INTEGER', true, '0'],
      ['completion_tokens', 'INTEGER', true, '0'],
      ['cached_tokens', 'INTEGER', true, '0'],
      ['prompt_tokens_cache_known', 'INTEGER', true, '0'],
      ['turns', 'INTEGER', true, '0'],
      ['updated_at', 'TEXT', true, null],
    ],
    primary: ['day', 'agent_group_id', 'session_id', 'episode_id', 'provider', 'model'],
    indexes: [
      {
        name: 'idx_usage_daily_day',
        columns: ['day'],
      },
    ],
  },
  {
    name: 'user_dms',
    columns: [
      ['user_id', 'TEXT', true, null],
      ['channel_type', 'TEXT', true, null],
      ['messaging_group_id', 'TEXT', true, null],
      ['resolved_at', 'TEXT', true, null],
    ],
    primary: ['user_id', 'channel_type'],
    foreign: [
      ['messaging_group_id', 'messaging_groups', 'id'],
      ['user_id', 'users', 'id'],
    ],
  },
  {
    name: 'users',
    columns: [
      ['id', 'TEXT', false, null],
      ['kind', 'TEXT', true, null],
      ['display_name', 'TEXT', false, null],
      ['platform_username', 'TEXT', false, null],
      ['user_key', 'TEXT', false, null],
      ['created_at', 'TEXT', true, null],
    ],
    primary: ['id'],
    indexes: [
      {
        name: 'idx_users_user_key',
        columns: ['user_key', 'kind'],
      },
    ],
  },
];

export const CENTRAL_SCHEMA = CENTRAL_TABLES.map(tableSql).join('\n');
