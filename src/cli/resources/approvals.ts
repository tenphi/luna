import { registerResource } from '../crud.js';
import { getPendingApproval } from '../../db/sessions.js';
import { dispatchResponse } from '../../response-registry.js';
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import type { CallerContext } from '../frame.js';

/**
 * Answer a pending card from the terminal.
 *
 * Every approval path assumed a chat channel: a card goes to an owner's DM and they tap a button.
 * That leaves no way to answer when the delivery itself is what's broken — no owner is reachable, the
 * bot token is wrong, the roster names nobody. `list`/`get` could show the row and nothing could
 * resolve it, so an agent waiting on a package install waited forever.
 *
 * The value sent is taken from the card's own `options_json` rather than hardcoded, because "approve"
 * is not one string across kinds: a channel-registration card approves with `connect:<agentGroupId>`.
 */
function resolveValue(optionsJson: string, decision: 'approve' | 'reject'): string {
  let options: { value?: unknown }[] = [];
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    if (Array.isArray(parsed)) options = parsed as { value?: unknown }[];
  } catch {
    /* a card with unreadable options still gets the generic value below */
  }
  const values = options.map((o) => (typeof o.value === 'string' ? o.value : '')).filter(Boolean);

  if (decision === 'reject') {
    return values.find((v) => v === 'reject') ?? 'reject';
  }
  // Prefer a literal 'approve'; otherwise the first option that isn't the refusal.
  return values.find((v) => v === 'approve') ?? values.find((v) => v !== 'reject') ?? 'approve';
}

async function answer(
  args: Record<string, unknown>,
  ctx: CallerContext,
  decision: 'approve' | 'reject',
): Promise<unknown> {
  // Host-only, enforced here rather than by `access`. `access: 'approval'` would need an approval to
  // answer an approval, and `access: 'open'` alone would let an agent at `cliScope: 'global'` approve
  // its own request — the whitelist in dispatch.ts only applies to `cliScope: 'agent'`.
  if (ctx.caller !== 'host') {
    throw new Error('Approvals can only be answered from the host terminal.');
  }

  const id = String(args.id ?? '').trim();
  if (!id) throw new Error(`Pass the approval id: luna approvals ${decision} <id>`);

  const row = getPendingApproval(id);
  if (!row) throw new Error(`No pending approval with id "${id}" — see \`luna approvals\`.`);

  const explicit = typeof args.value === 'string' ? args.value.trim() : '';
  const value = explicit || resolveValue(row.options_json ?? '[]', decision);

  const claimed = await dispatchResponse({
    questionId: id,
    value,
    userId: CLI_LOCAL_USER_ID,
    channelType: row.channel_type ?? 'cli',
    platformId: row.platform_id ?? 'local',
    threadId: null,
  });

  return {
    approval_id: id,
    kind: row.kind ?? 'action',
    action: row.action,
    decision,
    value,
    claimed,
    resolved: getPendingApproval(id) === undefined,
    ...(claimed ? {} : { note: 'No handler claimed this response — the row was left in place.' }),
  };
}

registerResource({
  name: 'approval',
  plural: 'approvals',
  table: 'pending_approvals',
  description:
    'Pending approval — in-flight approval cards waiting for an admin response. Created by requestApproval() (memory proposals, skill creation, unknown-sender and channel registration gates) and the OneCLI credential approval flow. Rows are deleted after the admin approves/rejects or the request expires.',
  idColumn: 'approval_id',
  columns: [
    {
      name: 'approval_id',
      type: 'string',
      description: 'Unique approval identifier (also used as the card questionId).',
    },
    {
      name: 'session_id',
      type: 'string',
      description: 'Session that requested the approval. Null for OneCLI credential approvals.',
    },
    {
      name: 'request_id',
      type: 'string',
      description: 'Original request identifier (OneCLI request UUID or same as approval_id).',
    },
    {
      name: 'action',
      type: 'string',
      description: 'Action type — matches the registered approval handler (e.g. memory_proposal, onecli_credential).',
    },
    { name: 'payload', type: 'json', description: 'JSON payload carried through to the approval handler.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'agent_group_id', type: 'string', description: 'Originating agent group.' },
    { name: 'channel_type', type: 'string', description: 'Channel the approval card was delivered on.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID the card was delivered to.' },
    {
      name: 'platform_message_id',
      type: 'string',
      description: 'Platform message ID of the delivered card (for editing on expiry).',
    },
    { name: 'expires_at', type: 'string', description: 'When this approval expires (OneCLI gateway TTL).' },
    {
      name: 'status',
      type: 'string',
      description: 'Current status.',
      enum: ['pending', 'approved', 'rejected', 'expired'],
    },
    { name: 'title', type: 'string', description: 'Card title shown to the admin.' },
    { name: 'options_json', type: 'json', description: 'Card button options as JSON array.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    approve: {
      access: 'open',
      description:
        'Answer a pending approval with yes, from the terminal. The break-glass path when no owner is reachable by chat. `--value <option>` sends an exact card option instead of the inferred one.',
      handler: (args, ctx) => answer(args, ctx, 'approve'),
    },
    reject: {
      access: 'open',
      description: 'Answer a pending approval with no, from the terminal.',
      handler: (args, ctx) => answer(args, ctx, 'reject'),
    },
  },
});
