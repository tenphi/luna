---
name: telegram-formatting
description: Telegram markdown cheat sheet — tables, nested lists, code blocks.
---

# Telegram formatting (Rich Markdown)

Telegram bot messages are delivered as **Rich Messages**. Write **GitHub-flavored markdown** in your reply body; the host passes it through as `rich_message.markdown`. Do not convert to HTML or Telegram MarkdownV2.

## Do

| Feature | Syntax |
|---------|--------|
| Bold | `**bold**` or `__bold__` |
| Italic | `*italic*` or `_italic_` |
| Strikethrough | `~~strike~~` |
| Inline code | `` `code` `` |
| Code block | fenced \`\`\` with optional language |
| Headings | `#` … `######` |
| Unordered list | `-`, `*`, or `+` |
| Ordered list | `1.` `2.` … (write consecutive numbers; host also renumbers lazy `1.`) |
| Nested under ordered | Indent sub-bullets 2–3 spaces under the `1.` item |
| Task list | `- [ ]` / `- [x]` |
| Quote | `>` |
| Table | GFM pipes (`\| A \| B \|`) |
| Link | `[label](https://…)` |
| Spoiler | `\|\|spoiler\|\|` |

Prefer structure for longer answers: a short heading, then lists or a table instead of a wall of plain text.

**Ordered lists:** Indent nested `-` bullets under each numbered item. Unindented bullets break the list into separate `1.` items on Telegram. The host renumbers lazy `1.` / `1.` / `1.` markers, but correct indentation is still required for nested content.

## Don't

- Emit HTML (`<b>`, `<pre>`, …) — the rich path expects markdown
- Use Telegram MarkdownV2 escaping (backslash before every special char)
- Rely on WhatsApp-style single-asterisk bold as the primary style — prefer `**bold**`
- Wrap OneCLI `connect_url` values in markdown links — put the bare URL on its own line
- Put unindented `-` bullets between ordered items (that restarts numbering at 1)

## Example

```markdown
## Summary

Here is the comparison:

| Option | Cost |
|--------|------|
| A | low |
| B | high |

Next steps:

1. Pick an option
   - Check the calendar
   - Confirm with the group
2. Confirm the date
```

Run `/telegram-formatting` only when you need a refresher; everyday Telegram replies should already follow this dialect.
