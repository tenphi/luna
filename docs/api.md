---
title: Command reference
---

# Command reference

`luna help` lists common commands. `luna help --all` shows advanced resources and their arguments. Most administrative commands accept `--json` for machine-readable output.

## Conversation and health

| Command              | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `luna`               | Interactive terminal chat                                |
| `luna ask "message"` | Ephemeral one-shot request                               |
| `luna status`        | Service and runtime state                                |
| `luna health`        | Model, memory, native tools, gateway, and runtime health |
| `luna doctor`        | Deeper install diagnosis                                 |

## Setup and service

```bash
luna setup
luna setup help
luna setup step apple
luna setup step email
luna setup apply
luna service status
luna service start
luna service stop
luna service restart
luna redeploy
luna redeploy --no-build
```

`setup apply` reruns the core install steps non-interactively. It is intended for an already configured install, not a substitute for choosing credentials and optional integrations.

`redeploy` builds the host and container, recycles agent containers, and restarts the host. `--no-build` reloads configuration and runtime state. Akno is managed separately.

## Configuration

```bash
luna config
luna config agent get
luna config models get
luna config users get
luna config memory get
luna config apple get
luna config email get
luna config host-mcp get
```

Use `get`, `set`, and the arguments shown by `luna help --all`. The agent's scoped CLI is distinct from the host CLI: permitted configuration changes can require owner approval, while host-only actions are rejected from an agent session.

## Telegram

`/health` and `/usage` inspect the install for its owner. `/topics` lists recent topics; `/clear` begins a fresh one. `/learn off` controls session learning. `/report <description>` records a local complaint and its context.

## Advanced resources

Messaging groups, wirings, users, destinations, sessions, approvals, reports, and dropped messages are available through the advanced command surface. Prefer the setup wizard for ordinary onboarding. Resource names and flags come from the registry in `src/cli/`; inspect `luna help --all` for the installed version rather than copying internal SQL.
