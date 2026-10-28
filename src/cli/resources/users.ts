import { registerResource } from '../crud.js';
import { getDb } from '../../db/connection.js';
import { bindUserKey, resolveUserKey } from '../../users/binding.js';
import { configUsers, rosterUser } from '../../users/roster.js';

registerResource({
  name: 'user',
  plural: 'users',
  table: 'users',
  description:
    'User — one messaging-platform identity. Not a person: a person is an entry under `users` in config/local.jsonc, and `user_key` records which of them this identity turned out to be. Rows are created on first contact.',
  idColumn: 'id',
  columns: [
    {
      name: 'id',
      type: 'string',
      description:
        'Namespaced "channel_type:handle" — e.g. "telegram:1000000003", "cli:local", "email:user@example.com". Must be provided on create.',
      required: true,
    },
    {
      name: 'kind',
      type: 'string',
      description:
        'Channel type identifier (e.g. "telegram", "cli"). Used as a fallback for DM resolution when the id prefix doesn\'t match a registered adapter.',
      required: true,
    },
    {
      name: 'display_name',
      type: 'string',
      description:
        'Human-readable name. Shown in approval cards and logs. Auto-populated from the channel adapter, then overwritten by the configured `name` once this identity binds to a person.',
      updatable: true,
    },
    {
      name: 'platform_username',
      type: 'string',
      description:
        'Platform @username when known (e.g. Telegram), lowercased without @. Matched against `users.<key>.telegramHandle` in config to decide who this identity is.',
      updatable: true,
    },
    {
      name: 'user_key',
      type: 'string',
      description:
        'The config key this identity resolved to, learned on first contact. Null means the roster does not claim it and its messages are refused. Set it by hand with `luna users bind` when the platform exposes no handle to match on.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  customOperations: {
    bind: {
      // Host only, and open rather than approval-gated, for the same reason as `luna config users set`:
      // deciding which person an identity is *is* an admission decision, and approving one from a chat
      // is the pattern this design replaced.
      access: 'open',
      description:
        'Attach a channel identity to a configured person: --user <channel:id> --key <ref>. For accounts the roster cannot match on its own — a Telegram user with no public @username exposes no handle — and for re-pointing an identity that bound to the wrong person. Host only.',
      handler: async (args, ctx) => {
        if (ctx.caller !== 'host') {
          throw new Error('Identities are bound on the host, not by an agent. Run `luna users bind` there.');
        }
        const userId = String(args.user ?? args.id ?? '').trim();
        const key = String(args.key ?? '').trim();
        if (!userId || !key) {
          throw new Error('Pass both: luna users bind --user telegram:<id> --key <ref>');
        }

        if (!rosterUser(key)) {
          const known = configUsers().map((u) => u.key);
          throw new Error(
            `No configured user "${key}"${known.length ? ` — known keys: ${known.join(', ')}` : ' — the roster is empty'}. Add them with \`luna config users set --key ${key} …\` first.`,
          );
        }

        const row = getDb().prepare('SELECT id, kind FROM users WHERE id = ?').get(userId) as
          | { id: string; kind: string }
          | undefined;
        if (!row) {
          throw new Error(
            `No identity "${userId}" has been seen yet. It appears once they message Luna — check \`luna config users\` for unclaimed identities.`,
          );
        }

        // First-binding-wins is enforced for *automatic* handle matches, because there the input is
        // whatever a platform reported. Here the operator is naming both sides, so a deliberate
        // re-point is allowed — that is the whole reason this verb exists.
        const taken = getDb()
          .prepare('SELECT id FROM users WHERE user_key = ? AND kind = ? AND id <> ?')
          .all(key, row.kind, userId) as { id: string }[];

        bindUserKey(userId, key);
        return {
          bound: userId,
          key,
          resolves_to: resolveUserKey(userId),
          ...(taken.length > 0
            ? {
                note: `"${key}" is also bound to ${taken.map((t) => t.id).join(', ')} on the same channel. Unbind the stale one if that is not intended.`,
              }
            : {}),
        };
      },
    },
  },
});
