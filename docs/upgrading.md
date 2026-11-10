---
title: Upgrading
---

# Upgrading

Luna and Akno are separate packages with separate background services. Upgrade each with its own two commands, then check that they still see each other. Read the [release notes](https://github.com/tenphi/luna/releases) first, and keep a current [backup](guides.md#logs-and-backups) of the private install directory and your knowledge folder.

## Luna

```bash
npm install -g @tenphi/luna@latest
luna redeploy
luna health
```

`luna redeploy` copies the new runtime into the private install directory (`~/.luna`, or `LUNA_HOME`), rebuilds the agent image, stops running agent containers, and restarts the background service. The image rebuild can take a few minutes. Your `config/local.jsonc`, `.env`, `data/`, `logs/`, and authored skills under `agent/` are kept; files the old release shipped and the new one no longer does are removed.

Run both commands together. Until `luna redeploy` runs, the background service is still the previous release, and if it restarts in that window it starts the old code against the newly installed dependencies.

`npm ls -g @tenphi/luna` shows the installed version. To go back, install the earlier version the same way, for example `npm install -g @tenphi/luna@0.1.15`, and run `luna redeploy`. A release that changes Luna's database says so in its notes; returning to an earlier release past that point needs the backup taken before upgrading.

### Source checkout

```bash
git pull
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
luna redeploy
```

In a checkout, `luna redeploy` also builds the host before restarting it.

## Akno

```bash
npm install -g @tenphi/akno@latest
akno redeploy --no-build
akno doctor
```

`akno redeploy --no-build` restarts the Akno service on the new package and waits until its socket answers. Akno upgrades its own database automatically and never rewrites your Markdown for that. Run `akno migrate` only when its release notes name a Markdown migration, and rerun `akno service install` with the options you first used when they say the service definitions changed. See Akno's [operations guide](https://akno.tenphi.me/operations) for details.

Restarting Akno does not need a Luna restart: Luna reconnects on the next memory call.

## Check that they still match

Luna talks to Akno over a versioned protocol. Releases add operations without changing it, so most upgrades of either package keep working with the other. The protocol changes only when an existing exchange changes, and then both sides have to move.

After upgrading either one, check the Memory row of `luna health`:

- `Connected to Akno …` names the Akno version Luna reached.
- `Akno version mismatch: client speaks protocol …, server speaks …` means one side is ahead. Upgrade the other to its latest release. Until then, memory is off; chat, Apple services, and email keep working.

Upgrading both to their latest releases is the simplest way to stay matched.

## After changing Node

Both background services start the Node binary that was active when they were installed. Homebrew moves that binary on `brew upgrade node`, and nvm keeps a separate binary and separate global packages for each version. A new Node major version also needs Luna's native SQLite module rebuilt. After switching or upgrading Node, reinstall and restart under the new version:

```bash
npm install -g @tenphi/luna@latest
luna redeploy
npm install -g @tenphi/akno@latest
akno service install
akno doctor
```

Pass `akno service install` the same options you installed it with, such as `--no-dream`. If Calendar, Reminders, or Contacts then report missing access, rerun `luna setup step apple`.
