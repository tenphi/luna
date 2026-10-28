import type { NormalizedOption } from './channels/ask-question.js';
type Identity = { id: string; created_at: string };
type AgentBinding = { agent_group_id: string };
type ChannelRouting = { channel_type: string | null; platform_id: string | null; thread_id: string | null };
export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';
export type AgentGroup = Identity & { name: string; agent_provider: string | null };
export type MessagingGroup = Identity & {
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number;
  /** An owner's rejected conversation stays silent until explicitly wired. */
  denied_at?: string | null;
};
/** A channel identity binds to a configured person through user_key. Roles stay in private config. */
export type User = Identity & {
  kind: string;
  display_name: string | null;
  platform_username?: string | null;
  user_key?: string | null;
};
export type UserDm = { user_id: string; channel_type: string; messaging_group_id: string; resolved_at: string };
export type MessagingGroupAgent = Identity &
  AgentBinding & {
    messaging_group_id: string;
    engage_mode: EngageMode;
    engage_pattern: string | null;
    ignored_message_policy: IgnoredMessagePolicy;
    session_mode: 'shared' | 'per-thread' | 'agent-shared';
    priority: number;
  };
export type Session = Identity &
  AgentBinding & {
    messaging_group_id: string | null;
    thread_id: string | null;
    agent_provider: string | null;
    status: 'active' | 'closed';
    container_status: 'running' | 'idle' | 'stopped';
    last_active: string | null;
    /** CLI one-shot sessions can be collected after their retention period. */
    ephemeral?: 0 | 1;
  };
export type PendingQuestion = ChannelRouting & {
  question_id: string;
  session_id: string;
  message_out_id: string;
  title: string;
  options: NormalizedOption[];
  created_at: string;
};
export type PendingApproval = Omit<ChannelRouting, 'thread_id'> & {
  approval_id: string;
  kind: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string;
  created_at: string;
  agent_group_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  title: string;
  options_json: string;
};
export type AgentDestination = AgentBinding & {
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
};
