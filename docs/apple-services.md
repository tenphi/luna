---
title: Apple services
---

# Apple services

Luna's Apple tools run on the Mac, behind the host MCP bridge. Agent containers do not receive macOS Automation permissions directly.

For several users, connect shared Apple resources: a calendar and reminder list shared with your household or group, and a shared Notes folder where appropriate. Luna uses the hosting Mac's accounts and permissions; each Telegram user's own Mac or iCloud account is not connected automatically. The configured calendar and reminder list are install-wide.

| Service   | Integration                             | Scope                                       |
| --------- | --------------------------------------- | ------------------------------------------- |
| Calendar  | EventKit                                | Configured calendar                         |
| Reminders | EventKit                                | Configured reminder list                    |
| Notes     | AppleScript                             | Configured folder when supplied             |
| Contacts  | AppleScript                             | Address book access granted to Luna         |
| Messages  | Local Messages database and AppleScript | Optional; requires broader host permissions |

## Connect

```bash
luna setup step apple
luna config apple get
```

Setup installs the Luna app wrapper so macOS can associate EventKit and Automation permissions with a stable application. Respond to the permission prompts in macOS. Calendar and reminder names must match lists that actually exist on your Mac.

```bash
luna config apple set --calendar "Household" --reminders-list "Household"
luna redeploy --no-build
```

Ask Luna to read an agenda before trying an edit. Calendar and Reminders helpers are shipped with the package, so ordinary users do not need a Swift toolchain.

## Choose an action policy

Each app supports `normal`, `read-only`, and `confirm-destructive` safety modes. `normal` allows its registered actions; it does not imply an approval prompt for every edit. Use a more restrictive mode when appropriate:

```bash
luna config apple set --safety-app calendar --safety-mode read-only
luna redeploy --no-build
```

Messages is disabled by default. Enable it only after reading the requested permissions and deciding whether the assistant needs that access. Email uses the separate Gmail integration, not Mail.app.

If access fails, check `luna health`, System Settings → Privacy & Security, and the [operations guide](guides.md).
