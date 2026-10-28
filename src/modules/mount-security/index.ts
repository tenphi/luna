import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { getMountAllowlistPath } from '../../install-paths.js';
import { log } from '../../log.js';

export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

const policySchema = z.object({
  allowedRoots: z.array(
    z.object({
      path: z.string().min(1),
      allowReadWrite: z.boolean(),
      description: z.string().optional(),
    }),
  ),
  blockedPatterns: z.array(z.string()),
});

export const parseMountAllowlist = (input: unknown): MountAllowlist => policySchema.parse(input);

export type MountAllowlist = z.infer<typeof policySchema>;

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

const sensitiveNames =
  '.aws .azure .docker .env .gcloud .gnupg .gpg .kube .netrc .npmrc .pypirc .secret .ssh credentials id_ed25519 id_rsa private_key'.split(
    ' ',
  );
let policy: MountAllowlist | null | undefined;

/** Missing configuration can be created later; invalid configuration fails closed. */
export function loadMountAllowlist(): MountAllowlist | null {
  if (policy !== undefined) return policy;
  const filename = getMountAllowlistPath();
  try {
    const decoded: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const parsed = policySchema.parse(decoded);
    policy = { ...parsed, blockedPatterns: Array.from(new Set([...sensitiveNames, ...parsed.blockedPatterns])) };
    return policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') policy = null;
    log.warn('Extra mounts are disabled until a valid external policy is available', { filename });
    return null;
  }
}

function absolute(input: string): string {
  return path.resolve(
    input === '~' ? os.homedir() : input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input,
  );
}

function canonical(input: string): string | undefined {
  try {
    return fs.realpathSync(absolute(input));
  } catch {
    return undefined;
  }
}

const deny = (reason: string): MountValidationResult => ({ allowed: false, reason });

export function validateMount(mount: AdditionalMount): MountValidationResult {
  const rules = loadMountAllowlist();
  if (!rules) return deny(`No usable mount policy at ${getMountAllowlistPath()}`);

  const target = mount.containerPath ?? path.basename(mount.hostPath);
  // eslint-disable-next-line no-control-regex
  if (!target.trim() || /\.\.|[:\\\x00-\x1f]/.test(target) || path.isAbsolute(target)) {
    return deny('The container destination must be a safe relative path');
  }
  if (!mount.hostPath.trim()) return deny('A host path is required');
  const source = canonical(mount.hostPath);
  if (!source) return deny('The host path cannot be resolved');
  const forbidden = rules.blockedPatterns.find((pattern) => source.includes(pattern));
  if (forbidden !== undefined) return deny(`The host path is excluded by mount policy (${forbidden})`);

  const root = rules.allowedRoots.find((candidate) => {
    const parent = canonical(candidate.path);
    if (!parent) return false;
    const relative = path.relative(parent, source);
    return (
      relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  });
  if (!root) return deny('The resolved host path is outside every permitted root');

  return {
    allowed: true,
    reason: `Permitted by ${root.path}`,
    realHostPath: source,
    resolvedContainerPath: target,
    effectiveReadonly: !(mount.readonly === false && root.allowReadWrite),
  };
}

export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}> {
  return mounts.flatMap((requested) => {
    const result = validateMount(requested);
    if (!result.allowed) {
      log.warn('Extra mount denied', { group: groupName, reason: result.reason });
      return [];
    }
    return [
      {
        hostPath: result.realHostPath!,
        containerPath: path.posix.join('/workspace/extra', result.resolvedContainerPath!),
        readonly: result.effectiveReadonly!,
      },
    ];
  });
}
