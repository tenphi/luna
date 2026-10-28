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

`release.yml` is manually dispatched and defaults to a rehearsal. It repeats repository, history, Gitleaks, build, typecheck, lint, format, tests, docs, and package-install checks, then uploads the tarball for review. It does not publish on a push.

Publishing needs an npm trusted publisher for `tenphi/luna` and `release.yml`, a GitHub `npm` environment protected by a required maintainer reviewer, and the repository variable `LUNA_NPM_PUBLISH_APPROVED=true`. Dispatch with `publish=true` only for the reviewed commit on `main`, and reset the variable afterward if each release should need a separate enable step. The first scoped-package creation may require npm's initial publishing flow before trusted publishing can be attached; use the same verified tarball.

Before spending a version number, verify the package does not already exist at that version and review `npm pack` contents. Keep `LICENSE`, `README.md`, defaults, tool instructions, native helpers, and all runtime dependencies in the tarball. Never publish an install directory.

## Documentation hosting

`docs.yml` builds on relevant pushes and pull requests, and deploys `main` through GitHub Pages. The repository's Pages source is GitHub Actions with `luna.tenphi.me` as its custom domain; `public/CNAME` ships the domain in the site artifact. Preview and audit the generated site before deploying changes.
