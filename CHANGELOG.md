# Changelog

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
