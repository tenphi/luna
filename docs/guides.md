---
title: Operations
---

# Operations

## A setup step failed

Start with `luna health` and `luna doctor`. Read `logs/setup.log` for progress, and `logs/setup-steps/` for the failed step. These files are private and may contain install paths or diagnostic data.

Fix the prerequisite and rerun only the affected step:

```bash
luna setup step container
luna setup step auth
luna setup step service
```

For an unavailable container runtime, check `container system status` and start it with `container system start`. A first image build needs network access and time to download tools.

## Luna replied that something went wrong

Run `luna status` or `luna health`, or read `logs/luna.error.log`. The agent's model errors appear there once its retries are exhausted, together with an agent runner or tool server that failed to start and an MCP server that failed to connect. Errors that a retry absorbed are not logged there.

## Native tools do not have access

Rerun `luna setup step apple`. Check macOS Privacy & Security permissions for the Luna app wrapper and verify that the configured calendar or reminder list exists. Use `luna config apple get` to inspect scope. Do not grant Full Disk Access unless a chosen integration needs it.

## Change configuration or update code

```bash
luna redeploy --no-build # reload configuration
luna redeploy            # rebuild after source changes
```

A code update needs a build and fresh processes. The agent runner is mounted read-only, but Bun does not reload already imported source. `redeploy` recycles agent containers so the next session uses the new code.

To install a new release, follow [Upgrading](upgrading.md). Customize through configuration and local skills; use a source checkout for code changes.

## Akno is unavailable

Use `akno doctor` and `akno dream status`. If `luna health` reports an Akno version mismatch, see [Upgrading](upgrading.md#check-that-they-still-match). Configure and restart Akno using its own documentation. Luna can disable memory with `luna config memory set --enabled false`; chat and other integrations remain available.

## Logs and backups

Host logs live in `logs/luna.log` and `logs/luna.error.log`. Runtime databases and attachments are under `data/`. Back up private config and state with the same care as the underlying calendar, email, and knowledge. Never publish the whole install directory. Stop the host with `luna service stop` before copying the complete private config and `data/` directory, then restart it with `luna service start`. For online database backups, use SQLite’s backup API so committed WAL data is included.

## Development checks

```bash
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm typecheck
pnpm lint
pnpm knip
pnpm test
pnpm test:container
pnpm check:repository
pnpm docs:doctor
pnpm docs:build
```

The host suite uses Vitest; the agent suite uses Bun. Native helpers are rebuilt from Swift by `scripts/build-*-helper.sh` and `scripts/build-mail-extract.sh` on macOS. CI uses invented fixtures and does not call live models or personal services.
