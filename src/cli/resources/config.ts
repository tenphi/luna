import {
  getMcpToolFilters,
  removeMcpToolFilterForServer,
  updateMcpToolFilterForServer,
} from '../../db/install-settings.js';
import {
  loadHostMcpInstallConfig,
  removeHostMcpServer,
  setHostMcpPort,
  setHostMcpServer,
} from '../../host-mcp/shared/config.js';
import { loadAppleConfig, saveAppleConfig } from '../../host-mcp/builtins/apple/shared/config.js';
import { loadMailConfig, saveMailConfig } from '../../host-mcp/builtins/email/shared/config.js';
import { readMailHealth } from '../../host-mcp/builtins/email/shared/health.js';
import { exclusionList } from '../../host-mcp/builtins/email/shared/exclusions.js';
import { previewMailExclusions } from '../../host-mcp/builtins/email/shared/imap/preview.js';
import { hasMcpToolFilter, type McpToolFilterPolicy } from '../../mcp-tool-filters.js';
import { loadLunaConfig, resolveInstallDefaults, resolveModelRole } from '../../config/loader.js';
import { patchLocalConfig, writeLocalConfig } from '../../config/write.js';
import type { ModelRole, ModelsConfig, NamedProviderConfig, ProviderKind, UserConfigDoc } from '../../config/schema.js';
import { parseMcpToolNameList } from '../mcp-tool-filter-args.js';
import { registerResource } from '../crud.js';
import { register } from '../registry.js';
import { memoryHealth, memorySocketPath } from '../../host-mcp/builtins/memory/provider.js';
import { getDb } from '../../db/connection.js';
import { CLI_LOCAL_USER_ID } from '../../platform-id.js';
import type { CallerContext } from '../frame.js';
import { configUsers, ownerKey, validateRoster } from '../../users/roster.js';
import { ensureHotMemoryPages } from '../../users/hot-memory.js';

/**
 * What Luna knows about memory, which is deliberately little: where the service is, whether it is
 * answering, and the three settings Luna owns. The knowledge base path, the models, the chunking,
 * the maintenance schedule and the retention window are Akno's own config — ask it with
 * `akno config` and `akno doctor`.
 */
async function memoryStatus() {
  const health = await memoryHealth();
  const configured = loadLunaConfig().memory ?? {};
  return {
    memory: {
      enabled: configured.enabled !== false,
      autoRecall: configured.autoRecall !== false,
      socket: memorySocketPath(),
      digest: configured.digest !== false,
      notify: configured.notify ?? 'pages',
      mission: configured.mission ?? null,
    },
    service: {
      reachable: health.ok,
      writable: health.writable,
      detail: health.detail,
    },
    note: 'The knowledge base, models and maintenance schedule are the memory service’s own config: `akno config`, `akno doctor`.',
  };
}

const MODEL_ROLES: ModelRole[] = ['main'];

const CONFIG_TOPICS = [
  { topic: 'agent', description: 'Agent container config (MCP servers, packages, effort)' },
  { topic: 'models', description: 'The agent’s model and the named endpoints it can use' },
  { topic: 'users', description: 'Who Luna talks to, and which of them owns the install' },
  { topic: 'memory', description: 'Where memory is, whether it answers, and the digest settings Luna owns' },
  { topic: 'apple', description: 'Apple apps via in-tree MCP (Calendar, Reminders, Notes, Contacts, Messages)' },
  { topic: 'email', description: 'Mailbox health, ignored labels/senders and a count preview of active exclusions' },
  { topic: 'host-mcp', description: 'Install-local host MCP wiring' },
  { topic: 'mcp-tools', description: 'Install-wide MCP tool allow/ignore filters' },
] as const;

/**
 * The roster as configured, plus which channel identities have bound to each person.
 *
 * The bindings are the half an operator cannot see in the file: config carries a Telegram handle, and
 * what actually resolves an inbound message is the numeric id learned on first contact. Showing both
 * is what makes "why is this person not getting through?" answerable.
 */
function usersStatus() {
  const bindings = getDb()
    .prepare('SELECT id, user_key, display_name, platform_username FROM users ORDER BY created_at')
    .all() as { id: string; user_key: string | null; display_name: string | null; platform_username: string | null }[];

  const problems = validateRoster();
  return {
    owner: ownerKey(),
    users: configUsers().map((u) => ({
      key: u.key,
      name: u.name,
      telegram_handle: u.telegramHandle,
      memory_page: u.memoryPage,
      hot_memory_page: u.hotMemorySlug,
      enabled: u.enabled,
      is_owner: u.key === ownerKey(),
      bound_identities: bindings.filter((b) => b.user_key === u.key).map((b) => b.id),
    })),
    unclaimed_identities: bindings
      .filter((b) => !b.user_key && b.id !== CLI_LOCAL_USER_ID)
      .map((b) => ({ id: b.id, seen_as: b.display_name, handle: b.platform_username })),
    problems: problems.map((p) => (p.key ? `${p.key}: ${p.message}` : p.message)),
    note: 'The host terminal is always privileged, whatever this says — a wrong owner cannot lock you out.',
  };
}

/**
 * The roster is edited from the host, and only from the host.
 *
 * Not `access: 'approval'` like every other config write, because approving a roster change *is* the
 * admission-by-tap this whole design removed: a card saying "the agent wants to add this person, allow?"
 * is the same decision the Allow/Deny card used to ask, wearing different clothes. Who Luna talks to is
 * decided by editing config — by hand, by setup, or by these commands — and an agent has no business
 * proposing it.
 *
 * `access: 'open'` with this guard rather than a scope entry, because the install agent runs at
 * `cliScope: 'global'`, which skips the resource whitelist in dispatch.ts entirely.
 */
function requireHost(ctx: CallerContext, verb: string): void {
  if (ctx.caller !== 'host') {
    throw new Error(
      `The roster is edited on the host, not by an agent. Run \`luna config users ${verb}\` there, or edit config/local.jsonc.`,
    );
  }
}

/** Apply one `--flag` to a user entry. Returns true when it changed something. */
function applyUserFlags(entry: UserConfigDoc, args: Record<string, unknown>): boolean {
  let touched = false;
  const str = (v: unknown): string => String(v).trim();

  if (args.name !== undefined) {
    const raw = str(args.name);
    entry.name = raw === '' || raw === 'null' ? null : raw;
    touched = true;
  }
  const handle = args['telegram-handle'] ?? args.telegram_handle;
  if (handle !== undefined) {
    const raw = str(handle).replace(/^@+/, '');
    entry.telegramHandle = raw === '' || raw === 'null' ? null : raw;
    touched = true;
  }
  const page = args['memory-page'] ?? args.memory_page;
  if (page !== undefined) {
    const raw = str(page);
    entry.memoryPage = raw === '' || raw === 'null' ? null : raw;
    touched = true;
  }
  if (args.enabled !== undefined) {
    entry.enabled = str(args.enabled) !== 'false' && args.enabled !== false;
    touched = true;
  }
  return touched;
}

function installDefaultsStatus() {
  const defaults = resolveInstallDefaults();
  const main = resolveModelRole('main');
  return {
    provider: defaults.provider ?? null,
    model: defaults.model ?? null,
    base_url: main.provider.baseUrl ?? null,
  };
}

function modelsStatus() {
  const cfg = loadLunaConfig();
  const roles: Record<string, unknown> = {};
  for (const role of MODEL_ROLES) {
    const resolved = resolveModelRole(role);
    roles[role] = {
      provider: resolved.provider.name,
      kind: resolved.provider.kind,
      id: resolved.id ?? null,
      baseUrl: resolved.provider.baseUrl ?? null,
    };
  }
  return {
    providers: cfg.providers ?? {},
    models: roles,
    note: 'Restart Luna for a model change to take effect. Memory’s own models are `akno config`.',
  };
}

function stripModelPrefix(raw: string): string {
  const t = raw.trim();
  const i = t.indexOf(':');
  return i >= 0 ? t.slice(i + 1) : t;
}

register({
  name: 'config',
  description: 'List config topics or run `luna config <topic> get`.',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, ctx) => {
    const topics = ctx.caller === 'agent' ? CONFIG_TOPICS.filter((t) => t.topic === 'agent') : [...CONFIG_TOPICS];
    return {
      topics: topics.map((t) => ({
        topic: t.topic,
        description: t.description,
        get: `luna config ${t.topic}`,
        set:
          t.topic === 'host-mcp'
            ? `luna config ${t.topic} set|remove`
            : t.topic === 'agent'
              ? `luna config agent set …`
              : `luna config ${t.topic} set`,
      })),
      help: 'Run `luna config help` or `luna config <topic> help` for verbs and flags.',
    };
  },
});

registerResource({
  name: 'config-section',
  plural: 'config',
  table: 'install_settings',
  description: 'Install-wide and agent Luna configuration.',
  idColumn: 'id',
  columns: [{ name: 'id', type: 'number', description: 'Always 1.', generated: true }],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description: 'Show install-wide main chat provider, model, and base URL (from models.main).',
      handler: async () => ({ defaults: installDefaultsStatus() }),
    },
    set: {
      access: 'approval',
      description:
        'Update models.main (chat) and optionally providers.openai.baseUrl. Prefer `luna config models set`. Restart Luna to apply.',
      handler: async (args) => {
        const provider = args.provider as string | undefined;
        const model = args.model as string | undefined;
        const baseUrl = (args['base-url'] ?? args.base_url ?? args.baseUrl) as string | undefined;
        if (provider === undefined && model === undefined && baseUrl === undefined) {
          throw new Error('Nothing to update — provide at least one of: --provider, --model, --base-url');
        }

        const patch: {
          models?: ModelsConfig;
          providers?: Record<string, NamedProviderConfig>;
        } = {};
        if (provider !== undefined || model !== undefined) {
          patch.models = {
            main: {
              ...(provider !== undefined ? { provider } : {}),
              ...(model !== undefined ? { id: model } : {}),
            },
          };
        }
        if (baseUrl !== undefined) {
          patch.providers = { openai: { baseUrl } };
        }
        writeLocalConfig(patch);
        return { defaults: installDefaultsStatus() };
      },
    },
    models: {
      access: 'open',
      description: 'Show resolved models (main/embedding/expansion/reranker) and providers.',
      handler: async () => modelsStatus(),
    },
    'models get': {
      access: 'open',
      description: 'Show resolved models (main/embedding/expansion/reranker) and providers.',
      handler: async () => modelsStatus(),
    },
    'models set': {
      access: 'approval',
      description:
        'Set a models.* role (--role main|memory|embedding|expansion|extraction|reranker) and/or a named provider (--provider-name + --base-url). Restart Luna after changing a model role.',
      handler: async (args) => {
        const roleRaw = (args.role as string | undefined)?.trim();
        const providerName = (args['provider-name'] ?? args.provider_name) as string | undefined;
        const baseUrl = (args['base-url'] ?? args.base_url ?? args.baseUrl) as string | undefined;
        const apiKeyEnv = (args['api-key-env'] ?? args.api_key_env ?? args.apiKeyEnv) as string | undefined;
        const kindRaw = (args.kind as string | undefined)?.trim();
        const id = (args.id ?? args.model) as string | undefined;
        const provider = args.provider as string | undefined;

        const roleTouched = roleRaw !== undefined;
        const providerTouched =
          providerName !== undefined && (baseUrl !== undefined || apiKeyEnv !== undefined || kindRaw !== undefined);

        if (!roleTouched && !providerTouched) {
          throw new Error(
            'Nothing to update — provide --role … and/or --provider-name with --base-url/--api-key-env/--kind',
          );
        }

        const patch: {
          models?: ModelsConfig;
          providers?: Record<string, NamedProviderConfig>;
        } = {};

        if (providerTouched) {
          const name = String(providerName).trim();
          if (!name) throw new Error('--provider-name must be non-empty');
          const entry: NamedProviderConfig = {};
          if (baseUrl !== undefined) entry.baseUrl = String(baseUrl);
          if (apiKeyEnv !== undefined) {
            const envName = String(apiKeyEnv).trim();
            if (!envName) throw new Error('--api-key-env must be a non-empty env var name');
            entry.apiKeyEnv = envName;
            entry.apiKey = { env: envName };
          }
          if (kindRaw !== undefined) {
            const kind = kindRaw as ProviderKind;
            if (kind !== 'openai-compatible' && kind !== 'llama-server-reranker') {
              throw new Error('--kind must be openai-compatible or llama-server-reranker');
            }
            entry.kind = kind;
          }
          patch.providers = { [name]: entry };
        }

        if (roleTouched) {
          const role = roleRaw as ModelRole;
          if (!MODEL_ROLES.includes(role)) {
            throw new Error(`--role must be one of: ${MODEL_ROLES.join(', ')}`);
          }
          const roleCfg: NonNullable<ModelsConfig[ModelRole]> = {};
          if (provider !== undefined) roleCfg.provider = String(provider);
          if (id !== undefined) roleCfg.id = stripModelPrefix(String(id));
          if (Object.keys(roleCfg).length === 0) {
            throw new Error('Nothing to update for role — provide --id/--model and/or --provider');
          }
          patch.models = { [role]: roleCfg };
        }

        writeLocalConfig(patch);
        // Nothing to sync anywhere. Memory's models are memory's config; this used to push Luna's
        // embedding, expansion and extraction choices into the memory database in three directions,
        // and a mismatch between the two copies was its own class of bug.

        return modelsStatus();
      },
    },
    'mcp-tools': {
      access: 'open',
      description: 'Show install-wide MCP tool allow/ignore lists (per server name).',
      handler: async () => ({ mcp_tool_filters: getMcpToolFilters() }),
    },
    'mcp-tools get': {
      access: 'open',
      description: 'Show install-wide MCP tool allow/ignore lists (per server name).',
      handler: async () => ({ mcp_tool_filters: getMcpToolFilters() }),
    },
    'mcp-tools set': {
      access: 'approval',
      description:
        'Set install-wide MCP tool allow/ignore for a server (raw MCP tool names). Applies to every agent group ' +
        'that has that MCP wired, plus luna on all groups. Requires container restart to take effect.',
      handler: async (args) => {
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const existing = getMcpToolFilters()[name] ?? {};
        const policy: McpToolFilterPolicy = { ...existing };

        const clearAllow = args['clear-allow'] !== undefined || args.clear_allow !== undefined;
        const clearIgnore = args['clear-ignore'] !== undefined || args.clear_ignore !== undefined;

        if (args.allow !== undefined) {
          policy.toolsAllow = parseMcpToolNameList(args.allow as string, '--allow');
        } else if (clearAllow) {
          delete policy.toolsAllow;
        }

        if (args.ignore !== undefined) {
          policy.toolsIgnore = parseMcpToolNameList(args.ignore as string, '--ignore');
        } else if (clearIgnore) {
          delete policy.toolsIgnore;
        }

        if (args.allow === undefined && args.ignore === undefined && !clearAllow && !clearIgnore) {
          throw new Error('Nothing to update — provide --allow, --ignore, --clear-allow, and/or --clear-ignore');
        }

        if (!hasMcpToolFilter(policy)) {
          removeMcpToolFilterForServer(name);
          return { server: name, removed: true };
        }

        updateMcpToolFilterForServer(name, policy);
        return {
          server: name,
          toolsAllow: policy.toolsAllow ?? null,
          toolsIgnore: policy.toolsIgnore ?? null,
        };
      },
    },
    'host-mcp': {
      access: 'open',
      description: 'Show install-local host MCP wiring config.',
      handler: async () => ({ host_mcp: loadHostMcpInstallConfig() }),
    },
    'host-mcp get': {
      access: 'open',
      description: 'Show install-local host MCP wiring config.',
      handler: async () => ({ host_mcp: loadHostMcpInstallConfig() }),
    },
    'host-mcp set': {
      access: 'approval',
      description:
        'Set install-local host MCP wiring for one server (command/args/cwd/env). Requires restart to apply.',
      handler: async (args) => {
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        if (args.port !== undefined) {
          const n = parseInt(String(args.port), 10);
          setHostMcpPort(n);
        }

        const command = args.command as string | undefined;
        const cwd = args.cwd as string | undefined;
        if (!command || !cwd) {
          throw new Error('--command and --cwd are required');
        }

        const parsedArgs = args.args ? (JSON.parse(args.args as string) as string[]) : [];
        const parsedEnv = args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {};
        const oneCliRaw = args['one-cli'] ?? args.one_cli ?? args.oneCli;
        const oneCli =
          oneCliRaw === undefined
            ? true
            : String(oneCliRaw) === 'true' || String(oneCliRaw) === '1' || oneCliRaw === true;

        const next = setHostMcpServer(name, {
          command,
          cwd,
          args: parsedArgs,
          env: parsedEnv,
          oneCli,
        });
        return { server: name, host_mcp: next };
      },
    },
    'host-mcp remove': {
      access: 'approval',
      description: 'Remove install-local host MCP wiring for one server.',
      handler: async (args) => {
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const next = removeHostMcpServer(name);
        return { server: name, host_mcp: next };
      },
    },
    apple: {
      access: 'open',
      description: 'Show Apple apps builtin config (calendar defaults, app enablement).',
      handler: async () => ({ apple: loadAppleConfig() }),
    },
    'apple get': {
      access: 'open',
      description: 'Show Apple apps builtin config (calendar defaults, app enablement).',
      handler: async () => ({ apple: loadAppleConfig() }),
    },
    'apple set': {
      access: 'approval',
      description: 'Update Apple apps builtin config in config/local.jsonc. Restart Luna to apply host server changes.',
      handler: async (args) => {
        const config = loadAppleConfig();

        if (args.enabled !== undefined) {
          config.enabled = String(args.enabled) !== 'false';
        }
        if (args.calendar !== undefined) {
          config.apps.calendar.defaultCalendar = String(args.calendar);
        }
        if (args['reminders-list'] !== undefined || args.reminders_list !== undefined) {
          config.apps.reminders.defaultList = String(args['reminders-list'] ?? args.reminders_list);
        }
        if (args['notes-folder'] !== undefined || args.notes_folder !== undefined) {
          config.apps.notes.defaultFolder = String(args['notes-folder'] ?? args.notes_folder);
        }

        const boolFlag = (raw: unknown): boolean => String(raw) === 'true' || raw === true;
        const enabledFlag = (raw: unknown): boolean => String(raw) !== 'false' && raw !== false;

        const appEnableFlags: Array<{ keys: string[]; app: keyof typeof config.apps }> = [
          { keys: ['messages-enabled', 'messages_enabled'], app: 'messages' },
          { keys: ['calendar-enabled', 'calendar_enabled'], app: 'calendar' },
          { keys: ['reminders-enabled', 'reminders_enabled'], app: 'reminders' },
          { keys: ['notes-enabled', 'notes_enabled'], app: 'notes' },
          { keys: ['contacts-enabled', 'contacts_enabled'], app: 'contacts' },
        ];
        for (const { keys, app } of appEnableFlags) {
          const raw = keys.map((k) => args[k]).find((v) => v !== undefined);
          if (raw !== undefined) {
            // messages uses "enabled true" semantics historically; others treat "false" as off.
            config.apps[app].enabled = app === 'messages' ? boolFlag(raw) : enabledFlag(raw);
          }
        }

        const safetyRaw = args['safety-mode'] ?? args.safety_mode;
        const safetyAppRaw = args['safety-app'] ?? args.safety_app;
        if (safetyRaw !== undefined) {
          const mode = String(safetyRaw);
          if (mode !== 'normal' && mode !== 'read-only' && mode !== 'confirm-destructive') {
            throw new Error('--safety-mode must be normal | read-only | confirm-destructive');
          }
          const apps =
            safetyAppRaw !== undefined
              ? [String(safetyAppRaw) as keyof typeof config.apps]
              : (Object.keys(config.apps) as Array<keyof typeof config.apps>);
          for (const app of apps) {
            if (!config.apps[app]) throw new Error(`Unknown Apple app: ${app}`);
            config.apps[app].safetyMode = mode;
          }
        }

        const touched =
          args.enabled !== undefined ||
          args.calendar !== undefined ||
          args['reminders-list'] !== undefined ||
          args.reminders_list !== undefined ||
          args['notes-folder'] !== undefined ||
          args.notes_folder !== undefined ||
          safetyRaw !== undefined ||
          appEnableFlags.some(({ keys }) => keys.some((k) => args[k] !== undefined));

        if (!touched) {
          throw new Error(
            'Nothing to update — provide at least one of: --enabled, --calendar, --reminders-list, --notes-folder, --messages-enabled, --contacts-enabled, --safety-mode',
          );
        }

        saveAppleConfig(config);
        return { apple: loadAppleConfig() };
      },
    },
    email: {
      access: 'open',
      description: 'Show mail config, per-mailbox health, and which tools the agent may use.',
      handler: async () => ({
        email: loadMailConfig(),
        health: readMailHealth(),
      }),
    },
    'email get': {
      access: 'open',
      description: 'Show mail config, per-mailbox health, and which tools the agent may use.',
      handler: async () => ({
        email: loadMailConfig(),
        health: readMailHealth(),
      }),
    },
    'email set': {
      access: 'approval',
      description:
        'Update install-wide mail settings in config/local.jsonc. Mailboxes belong to people — add one with ' +
        '`setup --step email`, not here. Restart Luna to apply.',
      handler: async (args) => {
        const config = loadMailConfig();

        const exclusions: { ignoreLabels?: string[]; ignoreSenders?: string[] } = {};
        for (const [flag, key, kind] of [
          ['ignore-labels', 'ignoreLabels', 'labels'],
          ['ignore-senders', 'ignoreSenders', 'senders'],
        ] as const) {
          const value = args[flag] ?? args[flag.replace(/-/g, '_')];
          if (value !== undefined) {
            const raw = String(value);
            exclusions[key] = exclusionList(
              Array.isArray(value)
                ? value
                : raw.trim().startsWith('[')
                  ? JSON.parse(raw)
                  : raw
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
              kind,
            );
          }
        }
        if (args.mailbox !== undefined) {
          const key = String(args.mailbox);
          const user = loadLunaConfig().users?.[key];
          if (!user?.email) throw new Error('mailbox must name a configured user mailbox');
          if (!Object.keys(exclusions).length)
            throw new Error('Per-mailbox updates require --ignore-labels or --ignore-senders');
          writeLocalConfig({ users: { [key]: { ...user, email: { ...user.email, ...exclusions } } } });
          return { mailbox: key, ...exclusions };
        }
        Object.assign(config, exclusions);

        if (args.enabled !== undefined) {
          config.enabled = String(args.enabled) !== 'false';
        }
        if (args['tools-allow'] !== undefined || args.tools_allow !== undefined) {
          const raw = String(args['tools-allow'] ?? args.tools_allow);
          config.toolsAllow = raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (args['max-body-chars'] !== undefined || args.max_body_chars !== undefined) {
          const raw = Number(args['max-body-chars'] ?? args.max_body_chars);
          if (!Number.isFinite(raw) || raw < 200) {
            throw new Error('--max-body-chars must be a number of at least 200');
          }
          config.maxBodyChars = Math.floor(raw);
        }

        const touched =
          Object.keys(exclusions).length > 0 ||
          args.enabled !== undefined ||
          args['tools-allow'] !== undefined ||
          args.tools_allow !== undefined ||
          args['max-body-chars'] !== undefined ||
          args.max_body_chars !== undefined;

        if (!touched) {
          throw new Error(
            'Nothing to update — provide --enabled, --tools-allow, --max-body-chars, --ignore-labels or --ignore-senders',
          );
        }

        saveMailConfig(config);
        return { email: loadMailConfig(), health: readMailHealth() };
      },
    },
    'email preview': {
      access: 'open',
      description:
        'Count included and excluded emails for --since YYYY-MM-DD [--until YYYY-MM-DD] [--mailbox key], without reading bodies. Host only.',
      handler: async (args, ctx) => {
        if (ctx.caller !== 'host')
          throw new Error('Email exclusion previews are available from the host terminal only.');
        if (typeof args.since !== 'string') throw new Error('Provide --since YYYY-MM-DD');
        const config = loadMailConfig();
        const mailboxes = config.mailboxes.filter(
          (mailbox) => args.mailbox === undefined || mailbox.key === String(args.mailbox),
        );
        if (!config.enabled || !mailboxes.length) throw new Error('No enabled matching mailbox');
        return {
          mailboxes: await Promise.all(
            mailboxes.map((mailbox) =>
              previewMailExclusions(mailbox, args.since as string, String(args.until ?? args.since)),
            ),
          ),
        };
      },
    },
    memory: {
      access: 'open',
      description: 'Show where memory is, whether it is answering, and the settings Luna owns.',
      handler: async () => memoryStatus(),
    },
    'memory get': {
      access: 'open',
      description: 'Show where memory is, whether it is answering, and the settings Luna owns.',
      handler: async () => memoryStatus(),
    },
    'memory set': {
      access: 'approval',
      description:
        'Update memory wiring in config/local.jsonc: --enabled, --auto-recall, --socket, --digest, --notify off|pages, --mission. Everything about the knowledge base itself is the memory service’s own config.',
      handler: async (args) => {
        const current = loadLunaConfig().memory ?? {};
        const next = { ...current };
        let touched = false;

        if (args.enabled !== undefined) {
          next.enabled = String(args.enabled) !== 'false' && args.enabled !== false;
          touched = true;
        }
        if (args['auto-recall'] !== undefined || args.auto_recall !== undefined) {
          const raw = args['auto-recall'] ?? args.auto_recall;
          next.autoRecall = String(raw) !== 'false' && raw !== false;
          touched = true;
        }
        if (args.socket !== undefined) {
          const raw = String(args.socket).trim();
          next.socket = raw === '' || raw === 'null' ? null : raw;
          touched = true;
        }
        if (args.digest !== undefined) {
          next.digest = String(args.digest) !== 'false' && args.digest !== false;
          touched = true;
        }
        if (args.notify !== undefined) {
          const raw = String(args.notify);
          if (raw !== 'off' && raw !== 'pages') {
            throw new Error("--notify must be 'off' or 'pages'");
          }
          next.notify = raw;
          touched = true;
        }
        if (args.mission !== undefined) {
          const raw = String(args.mission).trim();
          next.mission = raw === '' || raw === 'null' ? null : raw;
          touched = true;
        }

        if (!touched) {
          throw new Error(
            'Nothing to update — pass --enabled, --auto-recall, --socket, --digest, --notify or --mission',
          );
        }

        patchLocalConfig('memory', next);
        return memoryStatus();
      },
    },
    users: {
      access: 'open',
      description: 'Show who Luna talks to, which channel identities have bound to each, and who owns the install.',
      handler: async () => usersStatus(),
    },
    'users get': {
      access: 'open',
      description: 'Show who Luna talks to, which channel identities have bound to each, and who owns the install.',
      handler: async () => usersStatus(),
    },
    'users set': {
      access: 'open',
      description:
        'Add or change a person: --key <ref> with --name, --telegram-handle, --memory-page, --enabled. `--key x --owner` makes them the owner. The key is yours to choose and names their memory page (users/<key>), so it should not be a handle. Host only.',
      handler: async (args, ctx) => {
        requireHost(ctx, 'set');
        const key = String(args.key ?? '').trim();
        if (!key) throw new Error('Pass --key <ref> naming the person, e.g. --key ada');

        const current = loadLunaConfig().users?.[key] ?? {};
        const entry: UserConfigDoc = { ...current };
        const touched = applyUserFlags(entry, args as Record<string, unknown>);
        const makeOwner = args.owner !== undefined && String(args.owner) !== 'false' && args.owner !== false;

        if (!touched && !makeOwner) {
          throw new Error('Nothing to update — pass --name, --telegram-handle, --memory-page, --enabled or --owner');
        }

        writeLocalConfig({ users: { [key]: entry }, ...(makeOwner ? { owner: key } : {}) });

        // Give the new person a page now rather than at the next restart, so the operator can write
        // their standing notes immediately. Best-effort: memory may be down, and that is not a reason
        // to fail the roster edit.
        await ensureHotMemoryPages().catch(() => {});

        // Reported rather than thrown: a half-written roster is still worth saving, and refusing the
        // write would leave the operator unable to fix it one flag at a time.
        const problems = validateRoster();
        return {
          ...usersStatus(),
          ...(problems.length > 0 ? { warning: 'The roster has problems — see `problems`.' } : {}),
        };
      },
    },
    'users remove': {
      access: 'open',
      description:
        'Remove a person by --key. Their memory page is left alone; `users set --key x --enabled false` is the way to keep it and stop answering them. Host only.',
      handler: async (args, ctx) => {
        requireHost(ctx, 'remove');
        const key = String(args.key ?? '').trim();
        if (!key) throw new Error('Pass --key <ref> naming the person to remove');
        if (!loadLunaConfig().users?.[key]) throw new Error(`No configured user "${key}" — see \`luna config users\`.`);
        if (ownerKey() === key) {
          throw new Error(
            `"${key}" is the owner. Name a different owner first: luna config users set --key <other> --owner`,
          );
        }

        // An explicit null is how the local layer deletes an entry the default layer declared.
        writeLocalConfig({ users: { [key]: null } } as unknown as Parameters<typeof writeLocalConfig>[0]);
        return usersStatus();
      },
    },
  },
});
