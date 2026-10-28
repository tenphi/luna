import {
  readStoredContainerConfig,
  sanitizeMcpServerForStorage,
  updateStoredContainerConfig,
} from '../../container-config.js';
import { getTheAgent } from '../../bootstrap.js';
import { buildAgentGroupImage } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { assertValidPackageSpec } from '../../package-specs.js';
import { presentAgentConfig } from '../agent-config-present.js';
import { parseBoolFlag } from '../parse-bool-flag.js';
import { register } from '../registry.js';
import type { CallerContext } from '../frame.js';

function agentGroup(ctx: CallerContext) {
  const id = ctx.caller === 'agent' ? ctx.agentGroupId : getTheAgent().id;
  const ag = getAgentGroup(id);
  if (!ag) throw new Error('Agent group not found.');
  return ag;
}

async function showAgentConfig(ctx: CallerContext) {
  const ag = agentGroup(ctx);
  const stored = readStoredContainerConfig(ag);
  return { name: ag.name, ...presentAgentConfig(stored) };
}

register({
  name: 'config-agent',
  description: 'Show agent container config (model, MCP servers, packages).',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, ctx) => showAgentConfig(ctx),
});

register({
  name: 'config-agent-get',
  description: 'Show agent container config (model, MCP servers, packages).',
  access: 'open',
  parseArgs: () => ({}),
  handler: async (_args, ctx) => showAgentConfig(ctx),
});

register({
  name: 'config-agent-set',
  description: 'Update agent container config scalars. Run `luna restart` to apply.',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const ag = agentGroup(ctx);
    const patch: Parameters<typeof updateStoredContainerConfig>[1] = {};

    if (args.provider !== undefined) patch.provider = args.provider as string;
    if (args.model !== undefined) patch.model = args.model as string;
    if (args.effort !== undefined) patch.effort = args.effort as string;
    if (args.image_tag !== undefined || args['image-tag'] !== undefined) {
      patch.imageTag = (args.image_tag ?? args['image-tag']) as string;
    }
    if (args.assistant_name !== undefined || args['assistant-name'] !== undefined) {
      patch.assistantName = (args.assistant_name ?? args['assistant-name']) as string;
    }
    if (args.max_messages_per_prompt !== undefined || args['max-messages-per-prompt'] !== undefined) {
      patch.maxMessagesPerPrompt = Number(args.max_messages_per_prompt ?? args['max-messages-per-prompt']);
    }
    if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
      const scope = (args['cli-scope'] ?? args.cli_scope) as string;
      const normalized = scope === 'group' ? 'agent' : scope;
      if (!['disabled', 'agent', 'global', 'group'].includes(scope)) {
        throw new Error('--cli-scope must be one of: disabled, agent, group, global');
      }
      patch.cliScope = normalized as 'disabled' | 'agent' | 'global';
    }

    if (Object.keys(patch).length === 0) {
      throw new Error(
        'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope',
      );
    }

    const updated = updateStoredContainerConfig(ag.id, patch);
    return presentAgentConfig(updated);
  },
});

register({
  name: 'config-agent-add-mcp-server',
  description: 'Add an MCP server to the agent. Requires `luna restart`.',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const ag = agentGroup(ctx);
    const name = args.name as string;
    if (!name) throw new Error('--name is required');
    const host = args.host === true || args.host === 'true';
    const command = args.command as string | undefined;
    if (!host && !command) throw new Error('--command is required (or pass --host true)');
    if (host && command) throw new Error('Host MCP servers cannot use --command');

    const toolsAllowRaw = (args.tools_allow ?? args['tools-allow']) as string | undefined;
    const instructions = (args.instructions as string | undefined)?.trim();

    const stored = readStoredContainerConfig(ag);
    const servers = { ...stored.mcpServers };
    servers[name] = sanitizeMcpServerForStorage(
      host
        ? {
            host: true,
            ...(instructions ? { instructions } : {}),
            ...(toolsAllowRaw ? { toolsAllow: JSON.parse(toolsAllowRaw) as string[] } : {}),
          }
        : {
            command: command!,
            args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
            env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
          },
    );
    updateStoredContainerConfig(ag.id, { mcpServers: servers });
    return { added: name, servers };
  },
});

register({
  name: 'config-agent-remove-mcp-server',
  description: 'Remove an MCP server from the agent. Requires `luna restart`.',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const ag = agentGroup(ctx);
    const name = args.name as string;
    if (!name) throw new Error('--name is required');

    const stored = readStoredContainerConfig(ag);
    const servers = { ...stored.mcpServers };
    if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
    delete servers[name];
    updateStoredContainerConfig(ag.id, { mcpServers: servers });
    return { removed: name };
  },
});

register({
  name: 'config-agent-add-package',
  description: 'Add a package to the agent. Pass --rebuild to build and restart in the same approval.',
  access: 'approval',
  // Runs before the approval card is created, so a spec carrying shell
  // metacharacters is rejected outright instead of being shown to an owner who
  // might approve it — the spec ends up in a Dockerfile RUN line built as root.
  validateArgs: (raw) => {
    if (raw.apt !== undefined) assertValidPackageSpec('apt', raw.apt);
    if (raw.npm !== undefined) assertValidPackageSpec('npm', raw.npm);
  },
  approvalCard: (raw, ctx) => {
    const ag = ctx.caller === 'agent' ? getAgentGroup(ctx.agentGroupId) : getTheAgent();
    const name = ag?.name ?? 'agent';
    const current: { apt: string[]; npm: string[] } = ag
      ? readStoredContainerConfig(ag).packages
      : { apt: [], npm: [] };
    const apt = raw.apt as string | undefined;
    const npm = raw.npm as string | undefined;
    const withAdded = (list: string[], spec?: string) => (spec && !list.includes(spec) ? [...list, spec] : [...list]);
    const resultingApt = withAdded(current.apt, apt);
    const resultingNpm = withAdded(current.npm, npm);
    const rebuild = parseBoolFlag(raw.rebuild);

    const lines = [
      `Agent "${name}" wants to install a system package.`,
      '',
      `  apt: ${apt ?? '(none)'}`,
      `  npm: ${npm ?? '(none)'}`,
      `  resulting apt list: ${resultingApt.join(' ') || '(empty)'}`,
      `  resulting npm list: ${resultingNpm.join(' ') || '(empty)'}`,
      '',
    ];
    if (rebuild) {
      lines.push(
        'Approving rebuilds the agent image as root on this host (a few minutes),',
        'then restarts the agent.',
      );
    } else {
      lines.push('Approving records the package only. It takes effect on the next `luna restart --rebuild`.');
    }
    return { title: `Install package: ${apt ?? npm}`, question: lines.join('\n') };
  },
  parseArgs: (raw) => ({
    apt: raw.apt as string | undefined,
    npm: raw.npm as string | undefined,
    rebuild: parseBoolFlag(raw.rebuild),
    message: raw.message as string | undefined,
  }),
  handler: async (args, ctx) => {
    const ag = agentGroup(ctx);
    const { apt, npm } = args;
    if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');
    // Not redundant with validateArgs: host CLI callers, direct socket clients,
    // and the post-approval re-dispatch all land here with the raw frame.
    if (apt) assertValidPackageSpec('apt', apt);
    if (npm) assertValidPackageSpec('npm', npm);

    const stored = readStoredContainerConfig(ag);
    const packages = {
      apt: [...stored.packages.apt],
      npm: [...stored.packages.npm],
    };
    if (apt && !packages.apt.includes(apt)) packages.apt.push(apt);
    if (npm && !packages.npm.includes(npm)) packages.npm.push(npm);
    updateStoredContainerConfig(ag.id, { packages });

    if (!args.rebuild) {
      return {
        added: { apt: apt || null, npm: npm || null },
        note: 'Image rebuild required for packages to take effect.',
      };
    }

    // One approval covers record → build → respawn. Splitting this across
    // `add-package` and `restart --rebuild` would mean two cards with no
    // ordering guarantee: approving the restart first rebuilds without the
    // package and the agent wakes still broken.
    await buildAgentGroupImage(ag.id);
    const restarted = restartAgentGroupContainers(ag.id, 'package install', args.message);

    return {
      added: { apt: apt || null, npm: npm || null },
      rebuilt: true,
      restarted,
    };
  },
});

register({
  name: 'config-agent-help',
  description: 'Show agent config verbs and flags.',
  access: 'hidden',
  parseArgs: () => ({}),
  handler: async () =>
    [
      'config agent: Agent container config (model, MCP servers, packages).',
      '',
      'Verbs:',
      '  get [open] — show agent config',
      '  set [approval] — update scalars (--provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope)',
      '  add-mcp-server [approval] — wire MCP server (--name, --command or --host true)',
      '  remove-mcp-server [approval] — remove MCP server (--name)',
      '  add-package [approval] — add apt/npm package (--rebuild to build + restart in one approval, --message to resume)',
      '  remove-package [approval] — remove apt/npm package',
      '',
      'Examples:',
      '  luna config agent',
      '  luna config agent set --model <id>',
      '  luna config agent add-package --apt imagemagick --rebuild true --message "imagemagick is ready — finish the resize"',
      '  luna restart',
    ].join('\n'),
});

register({
  name: 'config-agent-remove-package',
  description: 'Remove a package from the agent. Requires `luna restart --rebuild`.',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args, ctx) => {
    const ag = agentGroup(ctx);
    const apt = args.apt as string | undefined;
    const npm = args.npm as string | undefined;
    if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

    const stored = readStoredContainerConfig(ag);
    const packages = {
      apt: apt ? stored.packages.apt.filter((p) => p !== apt) : stored.packages.apt,
      npm: npm ? stored.packages.npm.filter((p) => p !== npm) : stored.packages.npm,
    };
    updateStoredContainerConfig(ag.id, { packages });

    return {
      removed: { apt: apt || null, npm: npm || null },
      note: 'Image rebuild required for package changes to take effect.',
    };
  },
});
