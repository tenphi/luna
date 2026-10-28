import fs from 'fs';
import path from 'path';
import { getAgentDir } from '../install-paths.js';
import { sessionDir } from '../session-manager.js';
import type { HostMcpCaller } from './caller-context.js';

/**
 * Turning a `/workspace/...` path back into the host path it is a mount of.
 *
 * The agent is handed container paths and nothing else — `[document: bill.pdf — saved to
 * /workspace/inbox/m-42/bill.pdf]` — because the knowledge base is deliberately not mounted
 * into the sandbox and no host path may leak into anything the agent can echo. That is the
 * right design, and it left one tool broken: `memory_ingest` runs on the *host*, so the only
 * path the agent has to give it is the one path the host cannot open.
 *
 * So the translation happens here, at the boundary, from mounts the host already knows:
 *
 * - `/workspace/agent` → the install's agent directory (its own mount, and **not** a
 *   subdirectory of the session mount despite what the path suggests, so it is matched first)
 * - `/workspace/...`   → this session's directory
 *
 * Longest prefix wins, and the result is confirmed to be inside the directory it resolved
 * against before it is returned. A container is authenticated as its *group*, so a session id
 * it supplies can only ever select a folder beneath that group's own tree — but symlinks do
 * not respect prefixes, which is why the check is on the real path.
 */

export const WORKSPACE = '/workspace';

export interface Translation {
  hostPath: string;
  /** The path the caller gave, for putting back into anything the caller will read. */
  containerPath: string;
}

/** True for anything that looks like a container path rather than a host path or a URL. */
export function isWorkspacePath(value: string): boolean {
  return value === WORKSPACE || value.startsWith(`${WORKSPACE}/`);
}

export function translateWorkspacePath(containerPath: string, caller: HostMcpCaller | undefined): Translation | null {
  if (!isWorkspacePath(containerPath)) return null;

  const mounts: { prefix: string; hostRoot: string }[] = [{ prefix: `${WORKSPACE}/agent`, hostRoot: getAgentDir() }];
  if (caller?.sessionId && isPathSegment(caller.sessionId) && isPathSegment(caller.agentGroupId)) {
    mounts.push({ prefix: WORKSPACE, hostRoot: sessionDir(caller.agentGroupId, caller.sessionId) });
  }
  // Longest first, so `/workspace/agent/notes.pdf` is not resolved against the session dir.
  mounts.sort((a, b) => b.prefix.length - a.prefix.length);

  for (const mount of mounts) {
    if (containerPath !== mount.prefix && !containerPath.startsWith(`${mount.prefix}/`)) continue;
    const relative = containerPath.slice(mount.prefix.length).replace(/^\/+/, '');
    const candidate = relative ? path.join(mount.hostRoot, relative) : mount.hostRoot;
    if (!isInside(mount.hostRoot, candidate)) return null;
    return { hostPath: candidate, containerPath };
  }
  return null;
}

/**
 * One path segment, and nothing that navigates.
 *
 * The session id arrives as a claim from the container, and it is used to *build* the root
 * that everything else is then checked against — so `../other-group/sess-9` would pass a
 * containment check against the folder it had just escaped into. The identity has to be
 * validated before it becomes a path, not after.
 */
function isPathSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Real path, resolved through symlinks, still under `root`.
 *
 * A prefix test alone answers a question about strings. `inbox/m-42/bill.pdf` can be a
 * symlink to `~/.ssh/id_rsa`, and the string is inside the session folder either way.
 */
function isInside(root: string, candidate: string): boolean {
  const realRoot = realOrSelf(root);
  const real = realOrSelf(candidate);
  const relative = path.relative(realRoot, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    // Not there yet — resolve the deepest parent that is, so a missing leaf is still
    // judged against a real directory rather than escaping the check by not existing.
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realOrSelf(parent), path.basename(target));
  }
}

/**
 * Host paths must not travel back to the agent.
 *
 * Akno reports `no file at /Users/<name>/Library/.../inbox/m-42/bill.pdf`, which is both
 * useless to a container and a leak of the host layout the sandbox exists to withhold.
 * Saying it back in the agent's own vocabulary is more useful anyway.
 */
export function hideHostPath(text: string, translation: Translation | null): string {
  if (!translation) return text;
  return text.split(translation.hostPath).join(translation.containerPath);
}
