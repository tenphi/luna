---
title: Email
---

# Email

The built-in email integration uses Gmail over IMAP and SMTP with an app password. It works with threads, Gmail search, attachments, and drafts; it does not automate Mail.app.

## Connect a mailbox

```bash
luna setup step email
luna config email get
luna redeploy --no-build
```

Setup associates a mailbox with a configured person and stores its app password in the install's private `.env`. Gmail app-password availability depends on the account's security settings. Follow Google's account instructions if the option is unavailable.

## What is enabled

The default tools can search mail, read messages and threads, handle attachments, create drafts, and mark messages read. Sending, replying, and archiving are opt-in tools. There is no delete tool; spam and trash are excluded from the search surface.

Ask “Summarize the thread about the workshop” or “Create a draft reply proposing Friday”. Review the resulting draft in Gmail before sending it.

The selected mailbox is a convenience default, not a security boundary between people. A shared install may expose multiple configured mailboxes to tools. Use separate installs when people need independent access boundaries.

## Exclude noisy or sensitive mail

```bash
luna config email set --mailbox ada --ignore-labels '["Work updates"]' --ignore-senders '["notice@example.test"]'
luna config email preview --mailbox ada --since 2031-04-02
```

These examples use invented data. The preview reports counts and exclusions without message text. Restart Luna after changing configuration. Attachment and message caches are private runtime state under `data/`.
