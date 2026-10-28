# Working on Luna

Luna is a macOS personal assistant. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code. The [architecture](docs/architecture.md) maps the implementation; [security](docs/security.md) defines its boundaries.

## Private data is never source material

Use invented fixtures, examples, comments, benchmarks, and commit messages. Never copy real names, addresses, handles, message text, calendar entries, financial or identity records, credential values, or install paths into tracked files. Extract the shape of a real failure and reproduce it with invented content.

Use Ada Marlow, Bo Winters, Vulpine Mutual, and Blackwater Bay for examples. Private identifier lists belong outside the repository and can be passed to the scanner through `LUNA_PRIVACY_TERMS_FILE`.

`.env`, `config/local.jsonc`, `data/`, `logs/`, `agent/`, and the install's knowledge base are private state. Fixing a leaked value at HEAD is insufficient: remove it from history and rotate exposed credentials. Scanners report locations and categories, never the matched values.

## Runtime invariants

- macOS hosts only. Agent containers use Linux userspace in Apple Container.
- The host owns the central DB and each session's single `session.db`. Containers use the authenticated Session API; never reopen SQLite from a container or reintroduce two-file IPC.
- Users are declared in the private roster. Unknown senders fail closed. `cli:local` is always privileged through its protected host socket.
- Host tools and delivery revalidate permissions against host-owned state.
- Akno is optional and separate. Luna does not configure its models, index its files, mount its knowledge folder, or manage maintenance. Keep unavailable evidence distinct from absence.
- Topic history is bounded; the agent can read parked episodes without mutating their ledger.
- Runtime assets and private install state must remain separate in the npm package and launcher.

## Development

Run commands directly. Host TypeScript uses Node/pnpm and Vitest; agent-runner uses Bun and `bun:test`. Do not run pnpm install in the Bun package.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:container
pnpm check:repository
pnpm docs:doctor
pnpm docs:build
pnpm smoke:package
```

After host or agent source changes, run `luna redeploy` when applying them to the active install. It builds, recycles agent containers, and restarts the host. A running Bun process does not reimport edited files. For a release candidate, verify it in its own install directory instead of letting an audit mutate private state.

Format host code with `pnpm format`; match local style in the container tree. Container typecheck is separate: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`. Runtime dependency changes there require `bun install` and its updated lockfile.

Use `gpt-6-luna` for explicitly run live language-model verification. Never substitute another model because of cost or availability. Preserve the configured embedding model. CI and package smoke tests use invented data and no live API calls.

## Supply chain and releases

Use frozen lockfiles in CI and automated builds. Do not change `onlyBuiltDependencies` without human authorization. Release-age exclusions are listed in `pnpm-workspace.yaml` and require maintainer authorization; every other dependency keeps the three-day gate.

Never publish npm, push history rewrites, or change repository visibility without maintainer approval. Prepare and audit concrete artifacts first. See [release preparation](docs/releasing.md).

Work in the current branch unless asked otherwise. Commits require authorization.
