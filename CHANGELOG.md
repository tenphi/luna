# Changelog

## 0.1.19

### Patch Changes

- [#12](https://github.com/tenphi/luna/pull/12) [`f384f15`](https://github.com/tenphi/luna/commit/f384f15d8fab34fe49fa5bd079c51c0865b8887b) Thanks [@tenphi](https://github.com/tenphi)! - A full disk no longer crashes the Luna host. Before, a log write that failed with "no space left on device" became an uncaught exception, so launchd restarted the host in the middle of a reply, and any log output written afterwards was silently dropped. Log files now skip the lines they cannot store, keep writing once there is room again, and record how much output was lost.

## 0.1.18

### Patch Changes

- [`9d0b2d2`](https://github.com/tenphi/luna/commit/9d0b2d2ef98dec8f6a25fbdce22d5debd325f708) Thanks [@tenphi](https://github.com/tenphi)! - Luna can now read a scheduled task's full instructions (`list_tasks` with a `taskId`) before editing them, so changing a long task such as a daily digest no longer stalls on the shortened list preview or asks you to paste the instructions back.

## 0.1.17

### Patch Changes

- [#4](https://github.com/tenphi/luna/pull/4) [`e70f43f`](https://github.com/tenphi/luna/commit/e70f43f555454df74f601b5357bdfa4e28d20620) Thanks [@tenphi](https://github.com/tenphi)! - Agent failures now reach `luna.error.log`, `luna status` and `luna health`: a model call that fails after its retries, an agent runner or tool server that cannot start, and an MCP server that cannot connect. Before, they were logged only at debug level, so a generic "Something went wrong" reply left no cause in the host logs. Model errors that a retry absorbs stay at debug level.

- [#5](https://github.com/tenphi/luna/pull/5) [`11fce48`](https://github.com/tenphi/luna/commit/11fce48a03c99fbb2b0e83f736e347dfe94555bf) Thanks [@tenphi](https://github.com/tenphi)! - `luna system-prompt-stats --session` and `--session-context --session` now read the session's `session.db`. They looked for per-session `inbound.db` and `outbound.db` files, which current installs no longer create, so both failed with "not found" or read a leftover file from an old install.

## 0.1.16

- An upgrade replaces each shipped runtime folder whole, so a skill, instruction, or source file that a release removes no longer lingers in the install directory.
- The `~/.local/bin/luna` shortcut picks up a package that `npm install -g` replaced, as the npm launcher already did.
- `luna health` names the Akno version it connected to, and reports a protocol mismatch with which side to upgrade instead of a plain outage.
- A new [upgrading guide](docs/upgrading.md) covers Luna, Akno, version matching, and Node changes.

Upgrading from 0.1.15: its shortcut cannot refresh itself, so run this upgrade once through npm's launcher with `"$(npm prefix -g)/bin/luna" redeploy`.

## 0.1.15 — public release preparation

- macOS host integrations for Calendar, Reminders, Notes, Contacts, and optional Messages.
- Gmail threads, attachments, and drafts.
- Isolated agent tools and natural topic switching.
- Optional Akno knowledge with recall, learning, and external-edit context.
- Standalone `@tenphi/luna` packaging, guided OpenAI defaults, and Cookbook documentation.
- Optional main-model access through the ChatGPT plan Codex is signed in to, with notices when memory answers on its backup provider.
- One-line memory notes in chat, and digests that say why an item was held or skipped.

This is the initial public history. Earlier private development and inherited upstream histories are not part of the public release.
