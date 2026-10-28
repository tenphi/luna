---
title: Isolation
---

# Isolation

A session container isolates agent shell and file tools from the macOS host. It is a capability boundary, not a promise that all configured people have independent data access.

## What is separate

Each active session has its own container and host-owned message state. The container gets only the agent working directory, runtime source, and configured mounts. Host databases, macOS app permissions, and Akno's knowledge folder stay on the host.

A messaging group can use shared conversation state or separate sessions through its wiring. Shared sessions intentionally share conversational context. Separate sessions can still use the same agent workspace and host integrations.

## What can be shared

Agent workspace files, enabled host MCPs, configured mailboxes, and an Akno service can be shared by sessions. A default mailbox or current user memory page selects useful context; it is not an independent permission boundary.

Use separate Luna installs and separate service configuration when people need independent trust domains. Grant mounts narrowly, use read-only access where practical, and review the host tools exposed to each agent.

## Approvals

The host validates scoped CLI commands and destination permissions. Agent-initiated package and MCP configuration changes use the owner approval path. Apple action modes and OneCLI gateway policies determine their own gates; every tool call does not automatically produce a confirmation.

Read [security](security.md) before adding a mount or enabling an integration.
