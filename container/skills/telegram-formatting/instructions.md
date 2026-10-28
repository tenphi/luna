# Telegram formatting

When any destination is Telegram, write **GitHub-flavored markdown** (Rich Markdown): `**bold**`, `_italic_`, `` `code` ``, fenced blocks, `#`–`######` headings, GFM tables, `- [ ]` tasks, `>` quotes. Do not emit HTML or MarkdownV2 escaping — the host sends your markdown via Rich Messages. Prefer headings/lists/tables for longer answers. For ordered lists, write `1.` `2.` `3.` and indent nested `-` bullets under each item (unindented bullets restart numbering at 1). OneCLI connect URLs stay bare on their own line. Load `/telegram-formatting` for a full cheat sheet.
