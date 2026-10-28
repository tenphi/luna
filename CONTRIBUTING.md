# Contributing

Luna targets Apple silicon Macs and macOS host services. The container runtime uses Linux userspace; this does not imply Linux or Windows host support.

## Start here

Read [AGENTS.md](AGENTS.md), [architecture](docs/architecture.md), and [security](docs/security.md). Search existing issues and changes before starting related work. Keep a contribution focused and explain the user-visible result.

## Keep private data out

Every fixture, example, comment, benchmark input, and commit message must use invented data. Use Ada Marlow, Bo Winters, Vulpine Mutual, and Blackwater Bay for examples. Never paste a real message, name, address, account number, calendar entry, document excerpt, token, or installation path into the repository.

Private state belongs in `.env`, `config/local.jsonc`, `data/`, `logs/`, `agent/`, and the knowledge folder. They are not release assets. If private data reaches a commit, deleting it later is insufficient: rewrite affected history and rotate any exposed credential.

## Code map and checks

The host is TypeScript on Node; `container/agent-runner` is a separate Bun package. Host tests use Vitest, agent tests use `bun:test`. Put an integration's native host code under `src/host-mcp/builtins/` and tool-use guidance under `container/skills/`.

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
pnpm smoke:package
```

Test from a fresh checkout or installed tarball. Tests must not require someone's live config, knowledge base, contacts, email, or model credentials. Model-backed verification uses `gpt-6-luna` when explicitly run; it is outside CI.

For an opt-in check of repository rules and skills on the OpenAI endpoint, run `pnpm eval:public-agent --runs 3` with a real API key. It uses synthetic sources and mocked services, with no installed agent state. See [agent behavior](docs/reproducibility.md) for scope and result interpretation.

Format host code with `pnpm format`. Match the existing style in the Bun tree instead of reformatting it with the host configuration. Commit the appropriate lockfile when changing dependencies. The release-age and build-script policy in `pnpm-workspace.yaml` requires maintainer authorization for changes.

## Review

Explain the concrete problem, resulting behavior, and relevant validation. Check the diff for installation-specific files and invented fixtures. Do not include private logs or traces to make a reproduction easier.

Luna is source-available under PolyForm Noncommercial 1.0.0. Contributions must preserve the license notices of third-party components. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
