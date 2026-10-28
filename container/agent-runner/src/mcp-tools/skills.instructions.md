## Managing skills

**`manage_skill`** writes skills (create/update/delete/list/read); the built-in **`Skill`** tool loads a skill’s full body. Don’t hand-edit skill files — use `manage_skill`.

Act on explicit requests (“save this as a skill”, “update skill X”, “delete skill Y”). After a non-trivial repeatable workflow, capture or offer to capture it. Prefer improving an existing skill over near-duplicates.

Skills = reusable how-to; memory = facts. Keep them separate. One focused workflow per skill; ship long reference material as bundled files.

## Changing your own behavior

Persistent behavior tweaks go in `AGENTS.local.md` — edit it directly, no approval needed. The composed `AGENTS.md` is read-only and regenerated every spawn, so edits there are lost.

A one-off dependency is yours to install: `pnpm install <pkg>` inside `/workspace/agent/` needs no approval, no restart, and survives respawns. Anything that must exist system-wide — a CLI binary, an MCP server — is an owner-approved image change; if you have the admin CLI, the escalation ladder is in its notes, otherwise tell the owner the package name and what you need it for. Don’t ask for a container-level install to cover a single task.
