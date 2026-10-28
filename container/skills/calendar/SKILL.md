---
name: calendar
description: Apple Calendar — meetings, agenda, availability, and event management via EventKit on the configured default calendar. Use when the user asks about their calendar; not for your own scheduled tasks. Never use osascript in Bash.
---

# Mac Calendar

Use calendar tools (`list_calendar_events`, `create_calendar_event`, …) for the **configured default Apple Calendar** only (in-tree host MCP / EventKit). Do not use scheduling tools for personal calendar events. Never run `osascript` in Bash — it only exists on the host, not in the container.

## Managed calendar

You manage **one** calendar — the install default (named in the session `<calendar-agenda>` `calendar=` attribute, e.g. Household). Never ask which calendar to use. There is no multi-calendar list tool.

## Session agenda

On a **new session**, the runtime may inject a `<calendar-agenda>` block for that default calendar (next 14 days) with event `id:<uid>` values — or `(no events)` when the window is empty. Treat that as already loaded — do not re-list the same window unless the user asks for a refresh or a different range. Use those `id:` values for `get_calendar_event` / `update_calendar_event` / `delete_calendar_event`.

## When to use

- User asks about meetings, agenda, availability, or creating/updating calendar events
- Natural language dates work for **local** meetings (`tomorrow 9am`, `next friday 2pm`)

## Defaults

- Prefer `list_calendar_events` with a date range for routine agenda work beyond the injected window.
- Do not pass a calendar name — the host always uses the configured default.
- Titles you write open with a fitting emoji (`🦷 Dentist`, `✈️ Blackwater Bay → North Harbour`) — shared-base rule; existing events keep whatever title they already have.

## Event identity (uid)

- Every list/search/create result includes a stable **`uid`**. Always pass **`uid`** to `get_calendar_event`, `update_calendar_event`, and `delete_calendar_event`.
- Never update or delete by title alone — duplicate titles can hit the wrong event.
- After `create_calendar_event`, keep the returned `uid` for follow-up edits.
- Update/delete apply to a **single occurrence** of recurring events (`thisEvent`), except setting/clearing **recurrence**, which applies to this and future occurrences.

## Event details and changes

- Call `get_calendar_event` with `uid` to read full details including url, alerts, recurrence, and `timeZone`.
- Use `update_calendar_event` with `uid` to change title, times, location, description, all-day, timezone, url, alerts, or recurrence.
- Use `search_calendar_events` when you only know a title keyword and need to discover `uid`s.
- Alerts are **relative only** (`offsetMinutes` before the event). Absolute-date alarms are not exposed.
- File attachments are not supported (no public EventKit API).

## Times

- **Default: wall-clock, omit `timezone`.** Pass naive local times as the user means them in `<context timezone="…"/>` (install zone). Prefer ISO-like strings (`2031-05-14T14:00`).
- **Other-city meeting:** pass wall-clock in that city plus `timezone: "America/New_York"`.
- **Flights / cross-zone:** pass each city's local wall-clock and `timezone: "Asia/Tokyo,America/Los_Angeles"` (departure,arrival — comma-separated). Use **explicit calendar dates**, not `tomorrow`. Arrival local date may differ from departure. Confirm both local times and zones before create.
- Offset-aware ISO also works (`2031-05-14T10:00:00+09:00`); still confirm with the user.
- **All-day:** set `all_day: true`; do **not** pass `timezone`.
- List/get times are shown in the install timezone; returned `timeZone` is the pinned event zone (start zone for flights).

## Safety

- **Confirm** title and time (and zones when used) before `create_calendar_event` or `update_calendar_event`.
- **Confirm** before `delete_calendar_event` (and pass `confirm: true` when required).
- If a tool returns Calendar access denied / not authorized, tell the user to run `luna setup step apple` on the Mac and follow its permission instructions to allow Calendar access — do not invent workarounds via Bash.
