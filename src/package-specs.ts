/**
 * Allowlist validation for agent-requested package specs.
 *
 * Package specs reach a generated Dockerfile `RUN` line that executes **as
 * root at image-build time on the host** (see `renderAgentGroupDockerfile`),
 * so a spec carrying shell metacharacters is a root command injection. These
 * grammars are allowlists: a spec either matches exactly or it is rejected.
 * Nothing is ever escaped or stripped — escaping is how you get a second bug.
 *
 * Validated in four places, deliberately:
 *   1. `validateArgs` in the CLI dispatcher — BEFORE the approval gate, so a
 *      poisoned spec never reaches an owner's approval card.
 *   2. The `config-agent-add-package` handler — host callers, direct socket
 *      clients, and the post-approval re-dispatch.
 *   3. `renderAgentGroupDockerfile` — the only gate covering hand-edited
 *      `container.json` / `local.jsonc` / `default.jsonc`, which never pass
 *      through the CLI and have no runtime schema validation.
 */

/**
 * Debian binary package name, optional `:arch` qualifier, optional `=version` pin.
 *
 * The leading `[a-z0-9]` is load-bearing beyond format policing: it is what
 * stops an apt *option* (`--allow-downgrades`, `-o=APT::Get::AllowUnauthenticated`)
 * being smuggled in as a package name. Anchoring alone would not.
 */
export const APT_SPEC_RE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:=[A-Za-z0-9][A-Za-z0-9.+:~-]*)?$/;

/** Unscoped or scoped npm package name, without a version suffix. */
export const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Version, range, or dist-tag suffix. Deliberately narrower than full semver:
 * compound ranges need spaces and `|`, comparators need `<`/`>`, and globs
 * would glob — the spec lands unquoted in a `RUN` line, so `1.*` could expand
 * against the build context. `^`/`~` prefixes and `@latest` cover real use.
 */
export const NPM_VERSION_RE = /^[\^~]?[A-Za-z0-9][A-Za-z0-9.^~+-]*$/;

/** `github:owner/repo` with optional `#ref` — the form a git-installed package uses. */
export const NPM_GITHUB_RE = /^github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9._/-]+)?$/;

/** Long enough for `ffmpeg=7:5.1.6-0+deb12u1`-class pins, short enough to bound the Dockerfile. */
const MAX_SPEC_LENGTH = 100;

/** A rebuild installing more than this is a misconfiguration, not a request. */
const MAX_PACKAGES_PER_KIND = 40;

export type PackageKind = 'apt' | 'npm';

export function isValidAptSpec(spec: unknown): spec is string {
  return typeof spec === 'string' && spec.length > 0 && spec.length <= MAX_SPEC_LENGTH && APT_SPEC_RE.test(spec);
}

export function isValidNpmSpec(spec: unknown): spec is string {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > MAX_SPEC_LENGTH) return false;
  if (spec.startsWith('github:')) return NPM_GITHUB_RE.test(spec);

  // Split on the version separator, not on a scope's leading `@`. For a scoped
  // name the separator must fall after the `/`; for an unscoped one, after
  // index 0. No separator at all means the whole spec is a bare name.
  const at = spec.lastIndexOf('@');
  const slash = spec.indexOf('/');
  const isVersionSeparator = at > 0 && (slash === -1 ? true : at > slash);
  if (!isVersionSeparator) return NPM_NAME_RE.test(spec);

  return NPM_NAME_RE.test(spec.slice(0, at)) && NPM_VERSION_RE.test(spec.slice(at + 1));
}

/**
 * Throws with a message written to be read by the agent — it states the
 * grammar, gives examples, and says *why* metacharacters are refused, so the
 * model corrects the spec instead of concluding the command is broken.
 */
export function assertValidPackageSpec(kind: PackageKind, spec: unknown): string {
  const ok = kind === 'apt' ? isValidAptSpec(spec) : isValidNpmSpec(spec);
  if (ok) return spec as string;

  const shown = typeof spec === 'string' ? JSON.stringify(spec) : String(spec);
  const expected =
    kind === 'apt'
      ? 'a Debian package name, optionally with :arch and =version — e.g. "imagemagick", "ffmpeg=7:5.1.6-0+deb12u1"'
      : 'an npm package name, optionally with @version, or a github: spec — e.g. "prettier", "@scope/pkg@1.2.3", "github:owner/repo#ref"';

  throw new Error(
    `Invalid ${kind} package spec ${shown}. Expected ${expected}. ` +
      `Shell metacharacters are not allowed: the spec is interpolated into a Dockerfile RUN line ` +
      `that executes as root at image-build time. Pass one package per --${kind} flag.`,
  );
}

/** Validate both stored package lists. Throws on the first bad entry. */
export function assertValidPackageLists(packages: { apt?: unknown; npm?: unknown }): void {
  for (const kind of ['apt', 'npm'] as const) {
    const list = packages[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(`Invalid ${kind} package list: expected an array, got ${typeof list}.`);
    }
    if (list.length > MAX_PACKAGES_PER_KIND) {
      throw new Error(`Too many ${kind} packages: ${list.length} (max ${MAX_PACKAGES_PER_KIND}).`);
    }
    for (const spec of list) assertValidPackageSpec(kind, spec);
  }
}
