---
name: notes
description: Apple Notes — folders and notes via host MCP. Prefer memory for durable knowledge; Notes for user-facing Apple Notes content. Never use osascript in Bash.
---

# Mac Notes

Use note tools (`list_note_folders`, `list_notes`, `get_note`, `create_note`, `update_note`, …) for **Apple Notes**. Never run `osascript` in Bash.

## Notes vs memory

- **Memory** = your durable knowledge base (facts, people, projects).
- **Apple Notes** = the user's Notes.app content they explicitly want there.

Do not dump chat history into Notes unless asked.

## Tips

- `create_note` body is HTML.
- Prefer `append_to_note` / `update_note` over recreate.
- Confirm before `delete_note` / `delete_folder`.
