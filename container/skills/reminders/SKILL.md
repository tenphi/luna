---
name: reminders
description: Apple Reminders — to-dos on the configured default list via EventKit. Use for personal reminders; not for your own cron/scheduled tasks or calendar events. Never use osascript in Bash.
---

# Mac Reminders

Use reminder tools (`list_reminders`, `create_reminder`, …) for the **configured default Apple Reminders list** only (in-tree host MCP / EventKit). Never run `osascript` in Bash.

## Managed list

You manage **one** reminder list — the install default (named in the session `<reminders-agenda>` `list=` attribute, e.g. Household). Never ask which list to use. There is no list-of-lists tool and you cannot create or delete lists.

## Session reminders

On a **new session**, the runtime may inject a `<reminders-agenda>` block for that default list with incomplete reminders that are undated or due within ~14 days (same horizon as calendar agenda) — or `(no reminders)` when empty. Farther dated reminders are omitted to reduce noise; use `list_reminders` if the user asks about them. Treat the injected block as already loaded — do not re-list unless the user asks for a refresh or completed items. Use `id:<uid>` values for `get_reminder` / `update_reminder` / `complete_reminder` / `uncomplete_reminder` / `delete_reminder`.

## What got done, and when

- Every reminder reports `completedAt` — when it was checked off, on any device. It can be `null` on a completed reminder another app checked off without stamping a date; say "completed" then, not a made-up time.
- **"What did I get done yesterday?"** is `list_reminders` with `completed_on` — one calendar day, whole day covered, newest first. Compute the date from the `date=` attribute of the session `<context …/>` header (`completed_on: "2026-08-12"` when that header says `2026-08-13`); relative words like "yesterday" are not dates and will be rejected.
- A span is `completed_from` / `completed_to` — "this week", "since Friday". Never pass `include_completed: true` and filter by hand; that pulls the whole completed backlog into the turn.
- Completed reminders no other client stamped with a date do not appear in a window at all. If the user insists something is missing, `include_completed: true` shows it with `completedAt: null`.

## Dates, repeats and alerts

- `dueDateAllDay: true` means the user set a day with no time. Report it as a day ("due Thursday"), never as 00:00. Writing works the same way round: `due_date: "14 May 2031"` is all-day, `"14 May 2031 at 6:40 PM"` is timed.
- `recurrence` is a repeat rule you can now read *and* write (`{frequency, interval, daysOfWeek, endDate, occurrenceCount}`) — "remind me every Monday" is one `create_reminder`, not a `schedule_task`. `update_reminder` replaces the whole rule; `recurrence: null` clears it.
- `alerts` are extra pings: `{offsetMinutes: 30}` (before the due date, so it needs one) or `{date: "…"}` for a fixed instant. A due date already alerts on every device — only add alerts when the user asked for another. `update_reminder` replaces the whole set; `alerts: null` clears it.
- Put a link in `url`, not in `body`. Reminders.app never shows the EventKit URL, so the host appends the link to the notes, where it is visible and tappable. Say a link is attached only when the returned `body` contains it. An older reminder can have a `url` missing from `body` — the user cannot see it; `update_reminder` with that same `url` moves it into the notes. Links the user typed into the app's own URL field are invisible to you.
- `start_date` is a deferred-until date almost nobody sets; leave it alone unless asked.

## List size

- List and search results are `{list, total, returned, truncated, reminders}`. When `truncated` is true you are not looking at everything: narrow the question (a completion day, a search term) or raise `limit` — do not summarise a clipped list as if it were the whole of it.

## When to use

- Shopping lists, personal to-dos, due-date reminders the user wants in Reminders.app
- Not for your own scheduled agent tasks (use scheduling tools) and not for timed meetings (use Calendar)

## Defaults

- Prefer `create_reminder` (not a legacy `add_reminder` name).
- Include `due` / notes / priority only when the user asked.
- Do not pass a list name — the host always uses the configured default.

## Reminder identity (uid)

- Every list/search/create result includes a stable **`uid`**. Always pass **`uid`** to get/update/complete/delete.
- Never mutate by title alone — duplicate titles can hit the wrong reminder.
- After `create_reminder`, keep the returned `uid` for follow-up edits.

## Safety

- Confirm before `delete_reminder` (and pass `confirm: true` when required).
- Prefer `complete_reminder` / `uncomplete_reminder` over delete when marking done.
- If a tool returns Reminders access denied / not authorized, tell the user to run `luna setup step apple` on the Mac and follow its permission instructions to allow Reminders access — do not invent workarounds via Bash.
