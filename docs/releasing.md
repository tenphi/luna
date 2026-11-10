---
title: Release preparation
---

# Release preparation

The npm package is `@tenphi/luna`. The documentation is a Cookbook static site at `https://luna.tenphi.me`, built into `site-dist/`. Host build output uses `dist/`; documentation cannot overwrite it.

## Run the gates

```bash
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm typecheck
pnpm lint
pnpm knip
pnpm format:check
pnpm test
pnpm test:container
pnpm audit --prod
pnpm check:repository
pnpm check:history
pnpm docs:doctor
pnpm docs:build
pnpm smoke:package
```

Supply a private JSON array of identifiers through `LUNA_PRIVACY_TERMS_FILE`; CI reads the same list from the `LUNA_PRIVACY_TERMS_JSON` secret. Scan artifacts with `node scripts/check-repository-safety.mjs --root /path/to/unpacked/artifact`. Scan all refs with `pnpm check:history` and Gitleaks. Reports contain locations and categories, not private values. Human review remains necessary for arbitrary prose, fixtures, binary assets, and unknown personal identifiers.

A leaked value must be removed from history, not only from `main`, and any exposed credential rotated. GitHub can keep unreachable objects, pull-request refs, Actions artifacts, and logs after a rewrite; consult GitHub's sensitive-data removal process when that matters.

## npm release

Luna uses the same Changesets release-PR loop as Akno. A change to published behavior carries a changeset file:

```bash
pnpm changeset
```

Choose the semver bump and write the user-facing changelog entry, then commit the generated `.changeset/*.md` file with the change. The entry also becomes the GitHub release notes, where repository-relative links do not resolve, so link documentation as `https://luna.tenphi.me/...`. Documentation, tests, CI, and internal tooling that do not change the npm package need no changeset.

When changes reach `main`, [`release.yml`](https://github.com/tenphi/luna/blob/main/.github/workflows/release.yml) opens or updates one `chore: release package` PR. It consumes the pending changesets, bumps `package.json` and `npm-shrinkwrap.json`, and writes `CHANGELOG.md`, so the exact release diff is reviewable. Merging that PR runs every gate again on the merge commit: repository and history scans, Gitleaks, typecheck, lint, Knip, format, both test suites, the production audit, the docs build, and the package install smoke. It then publishes the one tarball it packed and smoke-tested, tags it `v<version>`, and creates the GitHub release with the changelog entry and the tarball attached. Do not tag or publish by hand.

A manual run of the Release workflow is a rehearsal: it runs the same gates and uploads the tarball as the `luna-npm-tarball` artifact, but never versions, tags, or publishes.

Publishing uses npm trusted publishing, not a stored token. `@tenphi/luna` trusts the `tenphi/luna` repository and the `release.yml` workflow to run `npm publish`; the job requests `id-token: write` and npm exchanges that identity for a short-lived credential. The repository must allow GitHub Actions to create pull requests so the workflow can open the release PR. A release PR opened with the workflow token does not trigger CI by itself, so the workflow dispatches CI on its branch, and CI reports the result back to the PR as the `CI / generated release` status.

A version number is spent once. npm refuses one that is already on the registry, so rerunning a half-failed job cannot ship different bytes under the same number; bump the patch instead. Keep `LICENSE`, `README.md`, defaults, tool instructions, native helpers, and all runtime dependencies in the tarball. Never publish an install directory.

## Documentation hosting

`docs.yml` builds on relevant pushes and pull requests, and deploys `main` through GitHub Pages. The repository's Pages source is GitHub Actions with `luna.tenphi.me` as its custom domain; `public/CNAME` ships the domain in the site artifact. Preview and audit the generated site before deploying changes.
