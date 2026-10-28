---
title: Everyday use
---

# Everyday use

Message your configured Telegram bot from any device, in a direct message or a shared group. Several trusted people can use the same Luna and Akno knowledge base. Terminal chat is available with `luna`. Ask in ordinary language; Luna chooses tools from the capabilities you enabled.

Use a group chat for plans everyone should see, and direct messages for individual conversations. Knowledge learned through Akno joins the shared base. For Apple services, use calendars and reminder lists shared with the people using Luna. See [Telegram and shared use](telegram.md).

## Work with your day

“What is on my calendar tomorrow?” reads the configured calendar. “Remind me to send the draft on Friday” uses Apple Reminders. Enable and grant access through [Apple setup](apple-services.md) first.

For email, ask for a thread summary or a draft reply. Drafts are enabled by default; sending requires an explicit tool opt-in. [Email setup](email.md) explains the boundary.

## Change subjects naturally

Luna splits direct conversations into topics. A new, self-contained request can start a new topic; replies and references can return to an earlier one. The agent can read a parked topic's transcript when it needs context.

In Telegram, `/topics` lists the recent ledger and `/clear` starts a fresh topic. The history is bounded, so it is not an archival record. One-shot `luna ask` sessions do not use the persistent topic workflow.

## Work with files

Send an attachment or grant a specific folder mount. Text extraction, OCR, the browser, and shell tools run in the agent environment. A description helps route a file, but the agent should read the source before using a date or other exact detail.

Mount only folders the assistant needs. Broad home-directory access gives every shell command access to that material. See [isolation](isolation-model.md).

## Remember and correct

With [Akno](akno.md) enabled, ask Luna to remember a preference or consult a stored source. Memory changes name their pages so you can inspect them. Edit Markdown in your own editor to correct it; Luna can receive external-edit context for watched pages.

`/learn off` disables automatic learning for the current session. Set `memory.digest` to false to disable it install-wide, or disable `memory.enabled` to remove the integration entirely. Akno owns knowledge placement, retrieval, provenance, and maintenance.

## Diagnose a problem

`luna health` checks the install. `luna status` shows runtime state. In Telegram, `/health` is owner-only; `/report` records a complaint locally with the relevant exchange. Reports and logs can contain private data and are never publication artifacts.
