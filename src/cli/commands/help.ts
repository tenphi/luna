/**
 * Built-in help command. Introspects the resource and command registries.
 *
 *   luna help          — operator surface
 *   luna help --all    — full resource list (scripts / debugging)
 */
import { readStoredContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getResources } from '../crud.js';
import type { CallerContext } from '../frame.js';
import { listCommands, register } from '../registry.js';

const AGENT_SCOPE_RESOURCES = new Set(['sessions', 'destinations', 'members']);
const HIDDEN_FROM_DEFAULT = new Set([
  'wirings',
  'messaging-groups',
  'sessions',
  'users',
  'roles',
  'members',
  'user-dms',
  'dropped-messages',
  'approvals',
  'destinations',
  'config',
]);

function getCliScope(ctx: CallerContext): string | undefined {
  if (ctx.caller !== 'agent') return undefined;
  const ag = getAgentGroup(ctx.agentGroupId);
  return ag ? (readStoredContainerConfig(ag).cliScope ?? 'agent') : 'agent';
}

register({
  name: 'help',
  description: 'List available commands.',
  access: 'open',
  parseArgs: (raw) => ({ all: Boolean(raw.all) }),
  handler: async (args, ctx) => {
    const cliScope = getCliScope(ctx);
    const showAll = Boolean(args.all);

    if (cliScope === 'agent') {
      const lines: string[] = ['CLI scope: agent (destinations/sessions auto-scoped to you)', ''];
      const resources = getResources().filter((r) => AGENT_SCOPE_RESOURCES.has(r.plural));
      for (const r of resources) {
        lines.push(`  ${r.plural}`);
      }
      lines.push('');
      lines.push('Agent commands (no --id needed):');
      lines.push('  luna config agent');
      lines.push('  luna config agent set --model <id>');
      lines.push('  luna restart [--rebuild] [--message <text>]  Restart agent container');
      return lines.join('\n');
    }

    const lines: string[] = [];

    lines.push('Chat:');
    lines.push('  luna                         Interactive terminal chat (TTY)');
    lines.push('  luna ask <message...>        One-shot prompt (fresh session each time)');
    lines.push('');
    lines.push('Config:');
    lines.push('  luna config                  List config topics');
    lines.push('  luna config <topic>          Show topic config (agent, memory, apple, email, host-mcp, mcp-tools)');
    lines.push('  luna config <topic> set …    Update topic config');
    lines.push('  luna config help             Config verbs and flags');
    lines.push('');
    lines.push('Agent:');
    lines.push('  luna config agent            Show agent config (model, MCP, packages)');
    lines.push('  luna config agent set --model …');
    lines.push('  luna restart [--rebuild]     Restart agent container');
    lines.push('  luna status                  Health, wired channels, recent errors');
    lines.push('  luna health                  Models, memory, DB, builtins, OneCLI, runtime');
    lines.push('  luna doctor                  Install health checks');
    lines.push('');
    lines.push('Environment:');
    lines.push('  luna env                     Show install .env keys');
    lines.push('  luna env set --key … --value …');
    lines.push('');
    lines.push('Development:');
    lines.push('  luna redeploy                Rebuild host+container, stop stale containers, restart host');
    lines.push('  luna redeploy --no-build     Just stop stale containers + restart host');
    lines.push('  luna build [--restart]       Rebuild host + container image (dev)');
    lines.push('  luna service <verb>          Start/stop/restart host service (launchd)');
    lines.push('');
    lines.push('Setup:');
    lines.push('  luna setup                   Interactive first-time setup');
    lines.push('  luna setup apply             Non-interactive install steps');

    if (showAll) {
      lines.push('');
      lines.push('All resources (debug):');
      for (const r of getResources()) {
        lines.push(`  ${r.plural}`);
      }
      lines.push('');
      lines.push('All commands:');
      for (const c of listCommands().filter((cmd) => cmd.access !== 'hidden')) {
        lines.push(`  ${c.name.replace(/-/g, ' ')}`);
      }
    } else {
      lines.push('');
      lines.push('Run `luna help --all` for the full resource/command list.');
    }

    return lines.join('\n');
  },
});

export function registerResourceHelpCommands(): void {
  for (const res of getResources()) {
    if (HIDDEN_FROM_DEFAULT.has(res.plural)) continue;
    try {
      register({
        name: `${res.plural}-help`,
        description: `Show ${res.name} resource details.`,
        access: 'hidden',
        resource: res.plural,
        parseArgs: () => ({}),
        handler: async (_args, ctx) => {
          const cliScope = getCliScope(ctx);
          const lines: string[] = [];
          lines.push(`${res.plural}: ${res.description}`);
          if (cliScope === 'agent' && AGENT_SCOPE_RESOURCES.has(res.plural)) {
            lines.push('');
            lines.push('Note: scoped to your agent — no agent IDs required.');
          }
          lines.push('');
          const verbs: string[] = [];
          if (res.operations.list) verbs.push('list [open]');
          if (res.operations.get) verbs.push('get <id> [open]');
          if (res.operations.create) verbs.push('create [approval]');
          if (res.operations.update) verbs.push('update <id> [approval]');
          if (res.operations.delete) verbs.push('delete <id> [approval]');
          if (res.customOperations) {
            for (const [verb, op] of Object.entries(res.customOperations)) {
              verbs.push(`${verb} [${op.access}] — ${op.description}`);
            }
          }
          lines.push('Verbs:');
          for (const v of verbs) lines.push(`  ${v}`);
          return lines.join('\n');
        },
      });
    } catch {
      // Already registered
    }
  }
}
