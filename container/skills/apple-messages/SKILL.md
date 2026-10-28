---
name: apple-messages
description: Apple Messages (iMessage/SMS) — opt-in. Read chats and send only with explicit user confirmation of recipient + exact body. Never use osascript in Bash.
---

# Apple Messages

Opt-in host MCP (`apple_messages`). Disabled by default. Requires Full Disk Access for the Luna `.app` to read `~/Library/Messages/chat.db`.

## Tools

- `list_imessage_chats`, `get_imessage_chat_messages`, `search_imessages`
- `get_imessage_chat_participants`
- `send_imessage` — **confirm recipient + exact body with the user first**

## Safety

- Never send without explicit confirmation.
- If chat.db access is denied, tell the user to grant Full Disk Access to the Luna app and re-run the permission primer.
