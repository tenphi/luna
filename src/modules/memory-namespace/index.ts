/** Owner approval for a new top-level memory namespace. */
import type { AknoClient } from '@tenphi/akno-client';

import { getAgentGroup } from '../../db/agent-groups.js';
import { deletePendingApproval, getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { currentCaller } from '../../host-mcp/caller-context.js';
import { withMemory } from '../../memory/client.js';
import type { ApprovalHandlerContext } from '../approvals/index.js';

export const MEMORY_NAMESPACE_ACTION = 'memory_namespace';
const APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface NamespaceDeclaration {
  path: string;
  description: string;
  role?: 'knowledge' | 'source' | 'inference' | 'ignored';
  remember?: 'integrate' | 'deny';
  about?: string[];
  type?: string;
  idempotency_key?: string;
}

export function rootOf(path: string): string {
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  if (
    !normalized ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\*]/.test(normalized)
  ) {
    throw new Error('Use a plain memory slug with no empty, parent, wildcard or backslash segments.');
  }
  return normalized.split('/')[0]!;
}

export async function rootExists(client: AknoClient, path: string): Promise<boolean> {
  const root = rootOf(path);
  const result = await client.call('list', { kind: 'folders', limit: 2000 });
  return result.folders?.some((folder) => folder.path === root) ?? false;
}

/** Every destination-bearing tool uses this before its mutation. */
export async function assertExistingRoot(client: AknoClient, path: string): Promise<void> {
  if (await rootExists(client, path)) return;
  throw new Error(
    `Top-level memory namespace "${rootOf(path)}" needs owner approval. ` +
      `Call memory_folder with that root and its purpose, then wait for the owner's decision before retrying.`,
  );
}

export async function declareNamespace(input: NamespaceDeclaration): Promise<unknown> {
  const root = rootOf(input.path);
  // The MCP schema also carries a transient idempotency key. It is not part of the reviewed
  // policy: retries may have a new key, while the owner must approve only the stable fields.
  const declaration: NamespaceDeclaration = {
    path: input.path.trim(),
    description: input.description.trim(),
    ...(input.role ? { role: input.role } : {}),
    ...(input.remember ? { remember: input.remember } : {}),
    ...(input.about ? { about: input.about } : {}),
    ...(input.type ? { type: input.type } : {}),
  };
  return withMemory(async (client) => {
    if (await rootExists(client, input.path)) return client.call('folder', input);
    if (declaration.path !== root) {
      throw new Error(`First request approval for the top-level namespace "${root}" with memory_folder.`);
    }
    const caller = currentCaller();
    const session = caller?.sessionId ? getSession(caller.sessionId) : undefined;
    if (!session || session.agent_group_id !== caller?.agentGroupId) {
      throw new Error('A verified agent session is required to request a new memory namespace.');
    }
    // Validate Akno's reserved paths and policy schema before asking the owner to approve a
    // declaration that could never be applied. Dry-run does not create the folder.
    await client.call('folder', { ...declaration, dry_run: true });
    const pending = getPendingApprovalsByAction(MEMORY_NAMESPACE_ACTION).find((row) => {
      try {
        const payload = JSON.parse(row.payload) as { declaration?: NamespaceDeclaration };
        if (payload.declaration?.path !== root || row.status !== 'pending') return false;
        const createdAt = Date.parse(row.created_at);
        if (!Number.isFinite(createdAt) || Date.now() - createdAt > APPROVAL_LIFETIME_MS) {
          deletePendingApproval(row.approval_id);
          return false;
        }
        return true;
        // eslint-disable-next-line no-catch-all/no-catch-all -- malformed pending payload cannot authorize a namespace
      } catch {
        return false;
      }
    });
    if (pending) {
      const original = (JSON.parse(pending.payload) as { declaration: NamespaceDeclaration }).declaration;
      if (JSON.stringify(original) !== JSON.stringify(declaration)) {
        throw new Error(`A different policy for "${root}" is already awaiting the owner's decision.`);
      }
      return { status: 'ok', outcome: 'approval_pending', path: root, approval_id: pending.approval_id };
    }
    // Load approval delivery only when a genuinely new root is requested. A static import here
    // cycles through delivery -> memory server while the approval registry is initializing.
    const { requestApproval } = await import('../approvals/index.js');
    await requestApproval({
      session,
      agentName: getAgentGroup(session.agent_group_id)?.name ?? 'Luna',
      action: MEMORY_NAMESPACE_ACTION,
      payload: { declaration, issuedAt: Date.now() },
      title: 'New memory namespace',
      question: `Create top-level memory namespace "${root}"?\n\nPurpose: ${declaration.description}\nRole: ${declaration.role ?? 'knowledge'}; remember: ${declaration.remember ?? (declaration.role === 'knowledge' || !declaration.role ? 'integrate' : 'deny')}`,
    });
    return { status: 'ok', outcome: 'approval_pending', path: root };
  });
}

export async function applyNamespaceApproval(ctx: ApprovalHandlerContext): Promise<void> {
  const declaration = (ctx.payload as { declaration?: NamespaceDeclaration }).declaration;
  if (!declaration || rootOf(declaration.path) !== declaration.path || !declaration.description?.trim()) {
    throw new Error('The reviewed namespace declaration is invalid.');
  }
  // The exact reviewed declaration and issue time are stored on the approval row. A later
  // request for the same root cannot refresh an old card or change what it authorizes.
  const issuedAt = (ctx.payload as { issuedAt?: number }).issuedAt;
  if (
    typeof issuedAt !== 'number' ||
    !Number.isFinite(issuedAt) ||
    Date.now() - issuedAt > APPROVAL_LIFETIME_MS ||
    issuedAt > Date.now()
  ) {
    throw new Error('The namespace approval expired. Request it again.');
  }
  const result = await withMemory(async (client) => {
    if (await rootExists(client, declaration.path)) return { outcome: 'noop' };
    return client.call('folder', declaration);
  });
  ctx.notify(
    `The owner approved memory namespace "${declaration.path}" (${result.outcome}). ` +
      'The folder is ready; retry the original memory write if it is still needed.',
  );
}
