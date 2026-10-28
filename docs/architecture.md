---
title: Architecture
---

# Architecture

Luna is a macOS host process with a separate agent runtime in Apple Container. The host owns identity, channels, persistence, delivery, approvals, and native integrations. The container owns the model loop and isolated tools.

## Message flow

1. The terminal or Telegram adapter receives a message.
2. The host resolves the configured user, messaging group, agent group, and session.
3. The host persists the input and starts or wakes that session's agent container.
4. The container reads pending input through the authenticated Session API, resolves the conversation topic, and runs the model/tool loop.
5. It writes output through the same API. The host validates and delivers it through the channel.
6. Eligible memory work runs after the turn through the optional Akno client.

The central `data/luna.db` holds users, wiring, approvals, schedules, and install metadata. Each session has a single host-owned `session.db` with both message directions and a monotonic sequence. The container never opens those databases directly. New databases are created directly at schema version 1, recorded in SQLite’s `user_version`; historical pre-release upgrades are not shipped.

## Code map

| Area                          | Responsibility                                           |
| ----------------------------- | -------------------------------------------------------- |
| `src/channels/`               | Channel adapters and terminal transport                  |
| `src/router.ts`               | Routing and admission                                    |
| `src/db/`                     | Host SQLite state and schema initialization                         |
| `src/cli/`                    | CLI parsing, commands, dispatch, and approvals           |
| `src/config/`                 | JSONC defaults, overlays, normalization, and persistence |
| `src/container-runner.ts`     | Agent spawn and runtime wiring                           |
| `src/host-mcp/`               | Authenticated host bridge and built-in integrations      |
| `src/memory/`                 | Thin Akno client and conversation digest                 |
| `src/users/`                  | Roster binding and user memory context                   |
| `src/modules/`                | Permissions, approvals, and scheduling                   |
| `container/agent-runner/src/` | Bun agent loop, model client, tools, and topics          |
| `container/skills/`           | Shipped tool instructions                                |
| `setup/`                      | Install wizard and individual setup steps                |

## Runtime split

The host runs Node. The agent runtime runs Bun inside Linux userspace on the Mac's Apple Container VM. This is not Linux host support. Runtime source is mounted read-only into containers; the toolbelt and dependencies live in the image. A long-running Bun process keeps loaded modules until recycled.

Host-only native tools expose narrow MCP operations to sessions. Install-local MCPs can also be configured explicitly. Akno owns the Markdown knowledge base and its models; Luna calls its socket API and does not duplicate its index or maintenance logic.

## Topics and knowledge

Direct conversations keep a bounded episode ledger. Replies can resume an earlier episode; a classifier separates independent subjects. The agent can read parked history to recover relevant context. Optional Akno recall injects selected quoted evidence; learning and conversation mirrors use Akno's write contracts.

See [agent behavior](reproducibility.md) for shipped and private instruction layers and the opt-in OpenAI evaluation. See [isolation](isolation-model.md), [security](security.md), and [configuration](configuration.md) for the invariants around this flow.
