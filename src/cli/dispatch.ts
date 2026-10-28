/**
 * Transport-agnostic dispatcher. Both the socket server (host caller) and
 * the per-session DB poller (container caller) call dispatch() with the
 * same frame and a transport-supplied CallerContext.
 *
 * Approval gating for risky calls from the container is the only branch
 * that differs by caller. Host callers and `open` commands run inline.
 */
import { readStoredContainerConfig } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getSession } from '../db/sessions.js';
import { registerApprovalHandler, requestApproval } from '../modules/approvals/index.js';
import type { CallerContext, ErrorCode, RequestFrame, ResponseFrame } from './frame.js';
import { getResource } from './crud.js';
import { lookup } from './registry.js';

export async function dispatch(req: RequestFrame, ctx: CallerContext): Promise<ResponseFrame> {
  let cmd = lookup(req.command);

  if (!cmd) {
    for (let i = req.command.length - 1; i > 0; i--) {
      if (req.command[i] !== '-') continue;
      const prefix = req.command.slice(0, i);
      const suffix = req.command.slice(i + 1);
      const fallback = lookup(prefix);
      if (fallback) {
        cmd = fallback;
        req = { ...req, command: prefix, args: { ...req.args, id: req.args.id ?? suffix } };
        break;
      }
    }
  }

  if (!cmd) {
    return err(req.id, 'unknown-command', `no command "${req.command}"`);
  }

  // CLI scope enforcement for agent callers
  if (ctx.caller === 'agent') {
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const cliScope = agentGroup ? (readStoredContainerConfig(agentGroup).cliScope ?? 'agent') : 'agent';

    if (cliScope === 'disabled') {
      return err(req.id, 'forbidden', 'CLI access is disabled for this agent.');
    }

    if (cliScope === 'agent') {
      // `members` used to be here. It granted an agent-scoped agent the ability to add a user to its
      // own agent group — an admission decision, which now belongs to config/local.jsonc and nowhere
      // else. The resource is gone; the entry going with it is the point.
      const allowedResources = new Set(['sessions', 'destinations']);
      const allowedCommands = new Set([
        'help',
        'config',
        'config-help',
        'config-agent',
        'config-agent-get',
        'config-agent-set',
        'config-agent-help',
        'config-agent-add-mcp-server',
        'config-agent-remove-mcp-server',
        'config-agent-add-package',
        'config-agent-remove-package',
        'restart',
        'system-prompt-stats',
      ]);
      if (cmd.resource && !allowedResources.has(cmd.resource)) {
        return err(req.id, 'forbidden', `CLI access is scoped to this agent. Cannot access "${cmd.resource}".`);
      }
      if (!cmd.resource && !allowedCommands.has(req.command)) {
        return err(req.id, 'forbidden', `CLI command "${req.command}" is not available in agent scope.`);
      }

      const scopedArgs = ['agent_group_id', 'group'] as const;
      for (const key of scopedArgs) {
        if (req.args[key] && req.args[key] !== ctx.agentGroupId) {
          return err(req.id, 'forbidden', 'CLI access is scoped to this agent.');
        }
      }
      if (cmd.resource === 'destinations' && req.args.id && req.args.id !== ctx.agentGroupId) {
        return err(req.id, 'forbidden', 'CLI access is scoped to this agent.');
      }

      if (req.args.cli_scope !== undefined || req.args['cli-scope'] !== undefined) {
        return err(req.id, 'forbidden', 'Cannot change cli_scope from an agent-scoped agent.');
      }

      const fill: Record<string, unknown> = {
        agent_group_id: req.args.agent_group_id ?? ctx.agentGroupId,
        group: req.args.group ?? ctx.agentGroupId,
      };
      if (cmd.resource === 'destinations') {
        fill.id = req.args.id ?? ctx.agentGroupId;
      }
      req = { ...req, args: { ...req.args, ...fill } };

      if (cmd.resource === 'sessions' && req.command === 'sessions-get' && req.args.id) {
        const s = getSession(req.args.id as string);
        if (!s || s.agent_group_id !== ctx.agentGroupId) {
          return err(req.id, 'handler-error', `session not found: ${req.args.id}`);
        }
      }
    }
  }

  // Runs before the approval branch on purpose: a malformed request must never
  // reach an owner's approval card. `parseArgs` below is too late for that.
  try {
    cmd.validateArgs?.(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  if (ctx.caller !== 'host' && cmd.access === 'approval') {
    const session = getSession(ctx.sessionId);
    if (!session) {
      return err(req.id, 'handler-error', 'Session not found.');
    }
    const agentGroup = getAgentGroup(ctx.agentGroupId);
    const agentName = agentGroup?.name ?? ctx.agentGroupId;

    // Values are quoted so metacharacters read as data inside the command the
    // agent wants to run, rather than as shell the approver is agreeing to.
    const argSummary = Object.entries(req.args)
      .map(([k, v]) => `--${k.replace(/_/g, '-')} '${v}'`)
      .join(' ');
    const displayCommand = req.command.replace(/-/g, ' ');

    const card = cmd.approvalCard?.(req.args, ctx) ?? {};

    await requestApproval({
      session,
      agentName,
      action: 'cli_command',
      payload: { frame: { id: req.id, command: req.command, args: req.args } },
      title: card.title ?? `CLI: ${displayCommand}`,
      question:
        card.question ??
        `Agent "${agentName}" wants to run:\n\`luna ${displayCommand}${argSummary ? ' ' + argSummary : ''}\``,
    });

    return err(req.id, 'approval-pending', 'Approval request sent to admin. You will be notified of the result.');
  }

  let parsed: unknown;
  try {
    parsed = cmd.parseArgs(req.args);
  } catch (e) {
    return err(req.id, 'invalid-args', errMsg(e));
  }

  try {
    let data = await cmd.handler(parsed, ctx);

    if (ctx.caller === 'agent' && cmd.resource && cmd.generic) {
      const ag = getAgentGroup(ctx.agentGroupId);
      const scope = ag ? (readStoredContainerConfig(ag).cliScope ?? 'agent') : 'agent';
      if (scope === 'agent') {
        const def = getResource(cmd.resource);
        const groupField = def?.scopeField;
        if (!groupField) {
          return err(req.id, 'forbidden', `"${cmd.resource}" is not available in agent scope.`);
        }
        if (Array.isArray(data)) {
          data = data.filter(
            (row) =>
              typeof row === 'object' &&
              row !== null &&
              (row as Record<string, unknown>)[groupField] === ctx.agentGroupId,
          );
        } else if (data && typeof data === 'object') {
          if ((data as Record<string, unknown>)[groupField] !== ctx.agentGroupId) {
            return err(req.id, 'forbidden', 'Resource belongs to a different agent.');
          }
        }
      }
    }

    return { id: req.id, ok: true, data };
  } catch (e) {
    return err(req.id, 'handler-error', errMsg(e));
  }
}

function err(id: string, code: ErrorCode, message: string): ResponseFrame {
  return { id, ok: false, error: { code, message } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Re-export for tests
export { registerApprovalHandler };
